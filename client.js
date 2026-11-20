// SPDX-License-Identifier: GPL-2.0-or-later
// Combines the two ways to reach the Nextcloud desktop client:
// - CloudProviders (cloudproviders.js): most distribution and Flatpak builds;
//   no tray needed, pauses in any language. Doesn't report "offline", so that
//   comes from GNOME's network status.
// - The tray item (tray.js): the fallback, e.g. for Nextcloud's own AppImage;
//   needs a tray icon extension. Its icon also shows a real "offline" (server
//   unreachable), so its state wins when both are there.
// Keep this file free of GNOME Shell imports so it can be tested with plain gjs.
import Gio from 'gi://Gio';

import {CloudProvidersClient} from './cloudproviders.js';
import {TrayClient} from './tray.js';

const TRAY_STATES = ['ok', 'sync', 'pause', 'offline', 'warning', 'error'];

export class NextcloudClient {
    // labels: the tray menu's pause/resume labels per language, see tray.js
    constructor(onChanged, labels) {
        this._onChanged = onChanged;
        this._cloud = new CloudProvidersClient(() => this._onChanged());
        this._tray = new TrayClient(() => this._onChanged(), labels);
        this._network = Gio.NetworkMonitor.get_default();
        this._networkId = 0;
    }

    setLabels(labels) {
        this._tray.setLabels(labels);
    }

    start() {
        this._networkId = this._network.connect('network-changed', () => this._onChanged());
        this._cloud.start();
        this._tray.start();
    }

    stop() {
        if (this._networkId)
            this._network.disconnect(this._networkId);
        this._networkId = 0;
        this._cloud.stop();
        this._tray.stop();
    }

    get running() {
        return this._cloud.running || this._tray.running;
    }

    // Whether tray icon support is there; without it and without
    // CloudProviders, a running client can't be found
    get trayAvailable() {
        return this._tray.watcherAvailable;
    }

    // 'ok', 'sync', 'pause', 'offline', 'warning' or 'error'; '' when not running
    get state() {
        if (this._tray.running) {
            const state = this._tray.iconName.replace(/^state-/, '');
            return TRAY_STATES.includes(state) ? state : 'ok';
        }
        if (this._cloud.running) {
            const state = this._cloud.state;
            if (state !== 'pause' && !this._network.network_available)
                return 'offline';
            return state;
        }
        return '';
    }

    get tooltip() {
        if (this._tray.running)
            return this._tray.tooltip;
        return this._cloud.running ? this._cloud.tooltip : '';
    }

    async togglePause() {
        if (this._cloud.running)
            await this._cloud.togglePause();
        else if (this._tray.running)
            await this._tray.togglePause();
    }

    // Opens the client's main window
    async activate() {
        if (this._cloud.running && this._cloud.accounts.length > 0)
            await this._cloud.activate();
        else if (this._tray.running)
            await this._tray.activate();
    }

    // The client's menu as [{id, props, children, source}]
    async getMenu() {
        let source = null;
        if (this._cloud.running && this._cloud.accounts.length > 0)
            source = this._cloud;
        else if (this._tray.running)
            source = this._tray;
        if (!source)
            return [];

        const nodes = await source.getMenu();
        const tag = node => ({...node, source, children: node.children.map(tag)});
        return nodes.map(tag);
    }

    async click(node) {
        await node.source.click(node.id);
    }
}
