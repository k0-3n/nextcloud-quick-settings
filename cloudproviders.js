// SPDX-License-Identifier: GPL-2.0-or-later
// Talks to the Nextcloud desktop client through CloudProviders, the D-Bus
// interface most distribution and Flatpak builds of the client export: one
// account object per sync folder, with its status, a menu (org.gtk.Menus) and
// actions (org.gtk.Actions), including a "pause" action with an on/off state.
// Needs no tray and no translations. Nextcloud's own AppImage is built without
// it; tray.js covers that case.
// Keep this file free of GNOME Shell imports so it can be tested with plain gjs.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

const BUS_NAME = 'com.nextcloudgmbh.Nextcloud';
const ROOT_PATH = '/com/nextcloudgmbh/Nextcloud';
const ACCOUNT_IFACE = 'org.freedesktop.CloudProviders.Account';
const MANAGER_IFACE = 'org.freedesktop.DBus.ObjectManager';
const ACTIONS_IFACE = 'org.gtk.Actions';
const MENUS_IFACE = 'org.gtk.Menus';

// CloudProvidersAccountStatus
const STATUS_SYNCING = 2;
const STATUS_ERROR = 3;

// The client sends a few signals per change; refresh once for all of them
const REFRESH_DELAY_MS = 100;

function call(path, iface, method, params, replyType) {
    return Gio.DBus.session.call(BUS_NAME, path, iface, method, params,
        replyType ? new GLib.VariantType(replyType) : null,
        Gio.DBusCallFlags.NONE, 5000, null);
}

export class CloudProvidersClient {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._owner = null;
        this._watchId = 0;
        this._signalId = 0;
        this._refreshId = 0;
        this._refreshSerial = 0;
        this._stopped = false;
        this._menuActions = [];
        // [{path, name, status, details, paused}], one per sync folder
        this.accounts = [];
    }

    get running() {
        return this._owner !== null;
    }

    // 'ok', 'sync', 'pause' or 'error' over all sync folders
    get state() {
        const active = this.accounts.filter(a => !a.paused);
        if (this.accounts.length > 0 && active.length === 0)
            return 'pause';
        if (active.some(a => a.status === STATUS_ERROR))
            return 'error';
        if (active.some(a => a.status === STATUS_SYNCING))
            return 'sync';
        return 'ok';
    }

    // The client's own status text, e.g. "Connected - Success"
    get tooltip() {
        if (this.accounts.length === 1)
            return this.accounts[0].details;
        const worst = this.accounts.find(a => !a.paused && a.status === STATUS_ERROR) ??
            this.accounts.find(a => !a.paused && a.status === STATUS_SYNCING) ??
            this.accounts[0];
        return worst ? `${worst.name}: ${worst.details}` : '';
    }

    start() {
        this._watchId = Gio.bus_watch_name_on_connection(Gio.DBus.session, BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            (_conn, _name, owner) => this._onAppeared(owner),
            () => this._onVanished());
    }

    stop() {
        this._stopped = true;
        if (this._watchId)
            Gio.bus_unwatch_name(this._watchId);
        this._watchId = 0;
        this._unsubscribe();
    }

    _onAppeared(owner) {
        this._unsubscribe();
        this._owner = owner;
        // Any signal from the client (status, pause state, folders added or
        // removed) triggers a refresh
        this._signalId = Gio.DBus.session.signal_subscribe(owner, null, null, null, null,
            Gio.DBusSignalFlags.NONE, () => this._queueRefresh());
        this._refresh().catch(console.error);
    }

    _onVanished() {
        this._unsubscribe();
        this._owner = null;
        this.accounts = [];
        this._onChanged();
    }

    _unsubscribe() {
        if (this._signalId)
            Gio.DBus.session.signal_unsubscribe(this._signalId);
        this._signalId = 0;
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._refreshId = 0;
    }

    _queueRefresh() {
        if (this._refreshId)
            return;
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DELAY_MS, () => {
            this._refreshId = 0;
            this._refresh().catch(console.error);
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refresh() {
        const serial = ++this._refreshSerial;
        let accounts = [];
        try {
            const reply = await call(ROOT_PATH, MANAGER_IFACE, 'GetManagedObjects', null,
                '(a{oa{sa{sv}}})');
            const objects = reply.recursiveUnpack()[0];
            const paths = Object.keys(objects)
                .filter(path => ACCOUNT_IFACE in objects[path])
                .sort();
            accounts = await Promise.all(paths.map(async path => {
                const props = objects[path][ACCOUNT_IFACE];
                return {
                    path,
                    name: props.Name ?? '',
                    status: props.Status ?? 0,
                    details: props.StatusDetails ?? '',
                    paused: await this._getPaused(path),
                };
            }));
        } catch (e) {
            // The client went away meanwhile; _onVanished follows
            if (!this._stopped)
                console.debug(`Nextcloud QS: CloudProviders refresh failed: ${e.message}`);
        }
        if (this._stopped || serial !== this._refreshSerial || !this.running)
            return;
        this.accounts = accounts;
        this._onChanged();
    }

    async _getPaused(path) {
        const reply = await call(path, ACTIONS_IFACE, 'Describe',
            new GLib.Variant('(s)', ['pause']), '((bgav))');
        const [, , state] = reply.recursiveUnpack()[0];
        return state[0] === true;
    }

    // The client's actions take no parameter, or a string (a file path)
    _activate(path, action, target = null) {
        const params = target === null ? [] : [new GLib.Variant('s', String(target))];
        return call(path, ACTIONS_IFACE, 'Activate',
            new GLib.Variant('(sava{sv})', [action, params, {}]), null);
    }

    // Pauses every sync folder, or resumes them all when they're all paused.
    // The client's "pause" action toggles, so only touch folders that differ.
    async togglePause() {
        const pause = this.accounts.some(a => !a.paused);
        await Promise.all(this.accounts
            .filter(a => a.paused !== pause)
            .map(a => this._activate(a.path, 'pause')));
    }

    // Opens the client's main window
    async activate() {
        if (this.accounts.length > 0)
            await this._activate(this.accounts[0].path, 'openmaindialog');
    }

    // Reads the first sync folder's menu (org.gtk.Menus) as
    // [{id, props, children}], the same shape as the tray menu in tray.js
    async getMenu() {
        const account = this.accounts[0];
        if (!account)
            return [];

        const menus = new Map(); // "group:menu" -> items
        const subscribed = [];
        const subscribe = async groups => {
            subscribed.push(...groups);
            const reply = await call(account.path, MENUS_IFACE, 'Start',
                new GLib.Variant('(au)', [groups]), '(a(uuaa{sv}))');
            for (const [group, menu, items] of reply.recursiveUnpack()[0])
                menus.set(`${group}:${menu}`, items);
        };
        const linked = () => {
            const groups = new Set();
            for (const items of menus.values()) {
                for (const item of items) {
                    for (const link of [item[':section'], item[':submenu']]) {
                        if (link && !subscribed.includes(link[0]))
                            groups.add(link[0]);
                    }
                }
            }
            return [...groups];
        };

        try {
            await subscribe([0]);
            for (let groups = linked(); groups.length > 0; groups = linked())
                await subscribe(groups);
        } finally {
            call(account.path, MENUS_IFACE, 'End',
                new GLib.Variant('(au)', [subscribed]), null).catch(() => {});
        }

        this._menuActions = [];
        const build = (key, depth = 0) => {
            const nodes = [];
            for (const item of menus.get(key) ?? []) {
                const section = item[':section'];
                if (section) {
                    if (nodes.length > 0)
                        nodes.push({id: -1, props: {type: 'separator'}, children: []});
                    nodes.push(...build(`${section[0]}:${section[1]}`, depth));
                    continue;
                }
                const submenu = item[':submenu'];
                const children = submenu && depth < 3
                    ? build(`${submenu[0]}:${submenu[1]}`, depth + 1) : [];
                const props = {label: item.label ?? ''};
                const action = item.action?.replace(/^cloudprovider\./, '');
                if (action === 'pause') {
                    props['toggle-type'] = 'checkmark';
                    props['toggle-state'] = account.paused ? 1 : 0;
                }
                let id = -1;
                if (action) {
                    id = this._menuActions.length;
                    this._menuActions.push({path: account.path, action, target: item.target ?? null});
                }
                // An empty submenu shows its label as a disabled item
                if (submenu && children.length === 0)
                    props.enabled = false;
                if (!action && !submenu)
                    props.enabled = false;
                nodes.push({id, props, children});
            }
            return nodes;
        };
        return build('0:0');
    }

    async click(id) {
        const entry = this._menuActions[id];
        if (!entry)
            return;
        if (entry.action === 'pause')
            await this.togglePause(); // all sync folders, like the tile
        else
            await this._activate(entry.path, entry.action, entry.target);
    }
}
