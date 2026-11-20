// SPDX-License-Identifier: GPL-2.0-or-later
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {NextcloudClient} from './client.js';

const DESKTOP_ID = 'com.nextcloud.desktopclient.nextcloud.desktop';

// The Nextcloud desktop client's own tray icons (see icons/README), shown on
// the tile and in the top bar for the state the client reports
const STATES = ['ok', 'sync', 'pause', 'offline', 'warning', 'error'];
const INACTIVE_STATES = ['pause', 'offline'];

Gio._promisify(Gio.File.prototype, 'load_contents_async');

// The tray menu's "Pause sync" / "Resume sync" labels in every language, made
// by tools/extract-translations.py; only needed when the client is reached
// through its tray (see tray.js). Read in the background; until then (or if it
// fails) the tray menu is matched in English.
async function loadLabels(dir) {
    const [bytes] = await dir.get_child('translations.json').load_contents_async(null);
    return JSON.parse(new TextDecoder().decode(bytes));
}

const NextcloudToggle = GObject.registerClass(
class NextcloudToggle extends QuickSettings.QuickMenuToggle {
    _init(iconDir) {
        super._init({
            title: 'Nextcloud',
            toggleMode: false,
            menuEnabled: true,
        });

        this._iconDir = iconDir;
        this._menuBuildId = 0;

        // While the client runs, its own menu has an "Open" entry
        this._openItem = new PopupMenu.PopupMenuItem('Open Nextcloud');
        this._openItem.connect('activate', () => this._open());
        this.menu.addMenuItem(this._openItem);

        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);

        // Shown when the client can't be found: some builds (like Nextcloud's
        // AppImage) can only be reached through a tray icon
        this._hint = new PopupMenu.PopupMenuItem(
            'Start Nextcloud. If it is running, this build needs\n' +
            'tray icon support, e.g. the AppIndicator extension.', {reactive: false});
        this._hint.visible = false;
        this.menu.addMenuItem(this._hint);

        this._client = new NextcloudClient(() => this._sync());
        this.connect('clicked', () => this._onClicked());
        this.menu.connectObject('open-state-changed', (_menu, open) => {
            if (open)
                this._buildMenu().catch(console.error);
        }, this);

        this._sync();
        this._client.start();
    }

    _stateIcon(state) {
        const name = STATES.includes(state) ? state : 'ok';
        return Gio.FileIcon.new(this._iconDir.get_child(`nextcloud-state-${name}-symbolic.svg`));
    }

    setLabels(labels) {
        this._client.setLabels(labels);
    }

    _onClicked() {
        if (this._client.running)
            this._client.togglePause().catch(console.error);
        else
            this._open();
    }

    _open() {
        if (this._client.running)
            this._client.activate().catch(console.error);
        else
            Shell.AppSystem.get_default().lookup_app(DESKTOP_ID)?.activate();
        Main.panel.closeQuickSettings();
    }

    _sync() {
        const {running, state, tooltip, trayAvailable} = this._client;
        // Not running looks like offline (faded logo)
        const icon = this._stateIcon(running ? state : 'offline');
        this.gicon = icon;
        this.checked = running && !INACTIVE_STATES.includes(state);
        // Without CloudProviders and tray support a running client can't be
        // seen, so don't claim it isn't running
        this.subtitle = running ? null : trayAvailable ? 'Not running' : 'Not found';
        this.menu.setHeader(icon, 'Nextcloud', running ? tooltip : this.subtitle);
        this._hint.visible = !running && !trayAvailable;
        this._openItem.visible = !running;
        this.onSync?.(running, icon);
    }

    async _buildMenu() {
        const buildId = ++this._menuBuildId;
        const nodes = await this._client.getMenu();
        if (buildId !== this._menuBuildId)
            return;

        this._section.removeAll();
        nodes.forEach(node => this._addNode(this._section, node));
    }

    _addNode(parent, node) {
        const {props, children} = node;
        if (props.visible === false)
            return;

        if (props.type === 'separator') {
            parent.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            return;
        }

        const label = (props.label ?? '').replace(/_(.)/g, '$1');
        if (children.length > 0) {
            const submenu = new PopupMenu.PopupSubMenuMenuItem(label);
            children.forEach(child => this._addNode(submenu.menu, child));
            parent.addMenuItem(submenu);
            return;
        }

        const item = new PopupMenu.PopupMenuItem(label);
        if (props.enabled === false)
            item.setSensitive(false);
        if (props['toggle-type'] && props['toggle-state'] === 1)
            item.setOrnament(PopupMenu.Ornament.CHECK);
        item.connect('activate', () => {
            this._client.click(node).catch(console.error);
            Main.panel.closeQuickSettings();
        });
        parent.addMenuItem(item);
    }

    destroy() {
        this._menuBuildId++; // drop any menu build still in flight
        this.onSync = null;
        this._client.stop();
        super.destroy();
    }
});

const NextcloudIndicator = GObject.registerClass(
class NextcloudIndicator extends QuickSettings.SystemIndicator {
    _init(iconDir) {
        super._init();

        // Top bar icon, like Tailscale's: shown while the client runs, with
        // the same Nextcloud state icon as the tile
        this._icon = this._addIndicator();
        this._icon.visible = false;

        const toggle = new NextcloudToggle(iconDir);
        toggle.onSync = (running, gicon) => {
            this._icon.gicon = gicon;
            this._icon.visible = running;
        };
        toggle._sync();
        this.quickSettingsItems.push(toggle);
    }

    setLabels(labels) {
        this.quickSettingsItems.forEach(item => item.setLabels(labels));
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class NextcloudQuickSettings extends Extension {
    enable() {
        const dir = Gio.File.new_for_path(this.path);
        const indicator = new NextcloudIndicator(dir.get_child('icons'));
        this._indicator = indicator;
        Main.panel.statusArea.quickSettings.addExternalIndicator(indicator);

        loadLabels(dir).then(labels => {
            if (this._indicator === indicator) // not disabled meanwhile
                indicator.setLabels(labels);
        }).catch(e => {
            console.warn(`Nextcloud QS: no translations, English only: ${e.message}`);
        });
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
