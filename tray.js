// SPDX-License-Identifier: GPL-2.0-or-later
// Talks to the Nextcloud desktop client through its tray item (StatusNotifierItem).
// The fallback for client builds without CloudProviders (see cloudproviders.js);
// needs an extension that provides tray icons (a StatusNotifierWatcher).
// Keep this file free of GNOME Shell imports so it can be tested with plain gjs.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

const WATCHER_NAME = 'org.kde.StatusNotifierWatcher';
const WATCHER_PATH = '/StatusNotifierWatcher';
const WATCHER_IFACE = 'org.kde.StatusNotifierWatcher';
const ITEM_IFACE = 'org.kde.StatusNotifierItem';
const MENU_IFACE = 'com.canonical.dbusmenu';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';
const ITEM_ID = 'Nextcloud';
const LAYOUT_PROPS = ['type', 'label', 'visible', 'enabled', 'toggle-type', 'toggle-state', 'children-display'];

function call(dest, path, iface, method, params, replyType) {
    return Gio.DBus.session.call(dest, path, iface, method, params,
        replyType ? new GLib.VariantType(replyType) : null,
        Gio.DBusCallFlags.NONE, 5000, null);
}

async function getProp(dest, path, iface, name) {
    const reply = await call(dest, path, PROPS_IFACE, 'Get',
        new GLib.Variant('(ss)', [iface, name]), '(v)');
    return reply.get_child_value(0).get_variant();
}

function toNode([id, props, children]) {
    return {id, props, children: children.map(toNode)};
}

// Tray menu labels mark the keyboard accelerator with "_" ("__" is a literal
// "_"); Qt's own "&" may also slip through. Compare without them.
function normalize(label) {
    return label.replace(/__/g, '\0').replace(/[_&]/g, '').replace(/\0/g, '_')
        .trim().toLocaleLowerCase();
}

// Fallback when no translations are given: the client's English labels
const ENGLISH_LABELS = {
    pause: ['Pause sync', 'Pause sync for all'],
    resume: ['Resume sync', 'Resume sync for all'],
};

export class TrayClient {
    // labels: {pause: [...], resume: [...]}, the client's "Pause sync" and
    // "Resume sync" menu labels in every language (see translations.json)
    constructor(onChanged, labels = ENGLISH_LABELS) {
        this._onChanged = onChanged;
        this.setLabels(labels);
        this._item = null;
        this._itemSubs = [];
        this._scanId = 0;
        this._stopped = false;
        this._watcherSubs = [];
        // Whether a StatusNotifierWatcher (tray icon support) is there at all
        this.watcherAvailable = false;
        this.iconName = '';
        this.tooltip = '';
    }

    setLabels(labels) {
        this._pauseLabels = new Set(labels.pause.map(normalize));
        this._resumeLabels = new Set(labels.resume.map(normalize));
    }

    get running() {
        return this._item !== null;
    }

    start() {
        const bus = Gio.DBus.session;
        const rescan = () => this._scan().catch(console.error);
        this._watcherSubs = [
            bus.signal_subscribe(null, WATCHER_IFACE, null, WATCHER_PATH, null,
                Gio.DBusSignalFlags.NONE, rescan),
            // The watcher lives in Status Tray, which may load after this extension
            bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus',
                'NameOwnerChanged', '/org/freedesktop/DBus', WATCHER_NAME,
                Gio.DBusSignalFlags.NONE, rescan),
        ];
        rescan();
    }

    stop() {
        this._stopped = true;
        this._unbind();
        this._watcherSubs.forEach(id => Gio.DBus.session.signal_unsubscribe(id));
        this._watcherSubs = [];
    }

    async _findItem() {
        let entries;
        try {
            const value = await getProp(WATCHER_NAME, WATCHER_PATH, WATCHER_IFACE,
                'RegisteredStatusNotifierItems');
            entries = value.deepUnpack();
            this.watcherAvailable = true;
        } catch {
            this.watcherAvailable = false;
            return null; // no watcher (yet)
        }

        for (const entry of entries) {
            const slash = entry.indexOf('/');
            const bus = slash < 0 ? entry : entry.slice(0, slash);
            const path = slash < 0 ? '/StatusNotifierItem' : entry.slice(slash);
            try {
                const id = await getProp(bus, path, ITEM_IFACE, 'Id');
                if (id.deepUnpack() === ITEM_ID)
                    return {bus, path};
            } catch {
                // That item went away while we were looking
            }
        }
        return null;
    }

    async _scan() {
        const scanId = ++this._scanId;
        const found = await this._findItem();
        if (this._stopped || scanId !== this._scanId)
            return;

        if (found?.bus !== this._item?.bus || found?.path !== this._item?.path) {
            this._unbind();
            if (found)
                this._bind(found);
        }
        await this._refresh();
    }

    _bind(item) {
        const bus = Gio.DBus.session;
        const refresh = () => this._refresh().catch(console.error);
        this._item = item;
        this._itemSubs = ['NewIcon', 'NewToolTip', 'NewStatus'].map(signal =>
            bus.signal_subscribe(item.bus, ITEM_IFACE, signal, item.path, null,
                Gio.DBusSignalFlags.NONE, refresh));
    }

    _unbind() {
        this._itemSubs.forEach(id => Gio.DBus.session.signal_unsubscribe(id));
        this._itemSubs = [];
        this._item = null;
    }

    async _refresh() {
        const item = this._item;
        if (item) {
            try {
                const [icon, tooltip] = await Promise.all([
                    getProp(item.bus, item.path, ITEM_IFACE, 'IconName'),
                    getProp(item.bus, item.path, ITEM_IFACE, 'ToolTip'),
                ]);
                if (this._stopped || item !== this._item)
                    return;
                const [, , title, body] = tooltip.deepUnpack();
                this.iconName = icon.deepUnpack();
                this.tooltip = title || body;
            } catch {
                if (this._stopped || item !== this._item)
                    return;
                this._unbind();
            }
        }
        if (!this._item) {
            this.iconName = '';
            this.tooltip = '';
        }
        this._onChanged();
    }

    async activate() {
        if (this._item) {
            await call(this._item.bus, this._item.path, ITEM_IFACE, 'Activate',
                new GLib.Variant('(ii)', [0, 0]), null);
        }
    }

    async _aboutToShow(id) {
        try {
            await call(this._item.bus, this._menuPath, MENU_IFACE, 'AboutToShow',
                new GLib.Variant('(i)', [id]), '(b)');
        } catch {
            // Optional in the protocol
        }
    }

    async _getLayout() {
        const reply = await call(this._item.bus, this._menuPath, MENU_IFACE, 'GetLayout',
            new GLib.Variant('(iias)', [0, -1, LAYOUT_PROPS]), '(u(ia{sv}av))');
        return toNode(reply.recursiveUnpack()[1]);
    }

    // Returns the tray menu's top-level entries as {id, props, children}.
    // Submenus can fill in on AboutToShow, so fetch once more after asking for them.
    async getMenu() {
        if (!this._item)
            return [];

        const value = await getProp(this._item.bus, this._item.path, ITEM_IFACE, 'Menu');
        this._menuPath = value.deepUnpack();

        await this._aboutToShow(0);
        const root = await this._getLayout();
        const submenus = root.children.filter(n => n.props['children-display'] === 'submenu');
        if (submenus.length === 0)
            return root.children;

        await Promise.all(submenus.map(n => this._aboutToShow(n.id)));
        return (await this._getLayout()).children;
    }

    // Picks the client's "Pause sync (for all)" or "Resume sync (for all)" entry.
    // The client hides whichever doesn't apply; with some folders paused and
    // others not, both are shown, and the current state decides.
    findPauseEntry(nodes, paused) {
        const visible = nodes.filter(n => n.props.visible !== false);
        const find = labels => visible.find(n => labels.has(normalize(n.props.label ?? '')));
        const pause = find(this._pauseLabels);
        const resume = find(this._resumeLabels);
        return (paused ? resume ?? pause : pause ?? resume) ?? null;
    }

    async _findPauseEntry() {
        const entry = this.findPauseEntry(await this.getMenu(), this.iconName === 'state-pause');
        if (!entry)
            throw new Error('No pause or resume entry in the Nextcloud tray menu');
        return entry;
    }

    async togglePause() {
        const entry = await this._findPauseEntry();
        await this.click(entry.id);
    }

    async click(id) {
        await call(this._item.bus, this._menuPath, MENU_IFACE, 'Event',
            new GLib.Variant('(isvu)', [id, 'clicked', new GLib.Variant('i', 0),
                Math.floor(Date.now() / 1000)]), null);
    }
}
