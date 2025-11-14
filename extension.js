import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

const MaximizeToWorkspaceToggle = GObject.registerClass(
  class MaximizeToWorkspaceToggle extends QuickSettings.QuickToggle {
    _init(extension) {
      super._init({
        title: 'Maximize to Workspace',
        iconName: 'view-fullscreen-symbolic',
        toggleMode: true,
      });

      this._extension = extension;
      this._settings = extension.getSettings();

      this._settings.bind(
        'enabled',
        this,
        'checked',
        Gio.SettingsBindFlags.DEFAULT
      );

      this.connect('clicked', () => {
        this._settings.set_boolean('enabled', this.checked);
      });
    }
  });

export default class MaximizeToWorkspaceExtension extends Extension {
  constructor(metadata) {
    super(metadata);
    this._movedWindows = new WeakSet();
    this._pendingMove = new Map();
    this._signals = [];
    this._mutterSettings = null;
    this._quickSettingsItem = null;
    this._blacklist = new Set();
    this._whitelist = new Set();
    this._filterMode = 'none';
  }

  enable() {
    this._settings = this.getSettings();
    this._mutterSettings = new Gio.Settings({
      schema_id: 'org.gnome.mutter'
    });

    this._registerSimpleSettingsCache();

    this._connectSignal(global.window_manager, 'map', this._onWindowMap.bind(this));
    this._connectSignal(global.window_manager, 'destroy', this._onWindowDestroy.bind(this));
    this._connectSignal(global.window_manager, 'size-change', this._onWindowSizeChange.bind(this));
    this._connectSignal(global.window_manager, 'minimize', this._onWindowMinimize.bind(this));
    this._connectSignal(global.window_manager, 'unminimize', this._onWindowUnminimize.bind(this));

    this._quickSettingsItem = new MaximizeToWorkspaceToggle(this);
    this._indicator = new QuickSettings.SystemIndicator();
    this._indicator.quickSettingsItems.push(this._quickSettingsItem);
    Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
  }

  disable() {
    if (this._quickSettingsItem) {
      this._quickSettingsItem.destroy();
      this._quickSettingsItem = null;
    }

    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }

    this._signals.forEach(signal => {
      signal.object.disconnect(signal.id);
    });
    this._signals = [];

    if (this._settingsCacheId && this._settings) {
      for (const id of this._settingsCacheId)
        this._settings.disconnect(id);
      this._settingsCacheId = null;
    }

    this._pendingMove.clear();
    this._blacklist.clear();
    this._whitelist.clear();
    this._settings = null;
    this._mutterSettings = null;
  }

  // Utility methods

  _connectSignal(object, signal, callback) {
    const id = object.connect(signal, callback);
    this._signals.push({ object, id });
  }

  _getWS() {
    return global.workspace_manager;
  }

  _getMonitor(window) {
    return window.get_monitor();
  }

  _listWindowsFiltered(workspace, monitor) {
    return workspace.list_windows().filter(w =>
      !w.is_always_on_all_workspaces() && w.get_monitor() === monitor
    );
  }

  _registerSimpleSettingsCache() {
    const rebuild = () => {
      this._blacklist = new Set(this._settings.get_strv('blacklist'));
      this._whitelist = new Set(this._settings.get_strv('whitelist'));
      this._filterMode = this._settings.get_string('filter-mode');
    };

    rebuild();

    this._settingsCacheId = [
      this._settings.connect('changed::blacklist', rebuild),
      this._settings.connect('changed::whitelist', rebuild),
      this._settings.connect('changed::filter-mode', rebuild),
    ];
  }

  _isEnabled() {
    return this._settings.get_boolean('enabled');
  }

  _isNormalWindow(window) {
    return window.window_type === Meta.WindowType.NORMAL &&
      !window.is_always_on_all_workspaces();
  }

  _isWindowAllowed(window) {
    if (!this._isNormalWindow(window))
      return false;

    const wmClass = window.get_wm_class();
    if (!wmClass)
      return true;

    if (this._filterMode === 'blacklist')
      return !this._blacklist.has(wmClass);

    if (this._filterMode === 'whitelist')
      return this._whitelist.has(wmClass);

    return true; // 'none' or default
  }

  _shouldMoveOnMaximize(window) {
    return this._settings.get_boolean('move-on-maximize') &&
      window.is_maximized(Meta.MaximizeFlags.BOTH);
  }

  _shouldMoveOnFullscreen(window) {
    return window.fullscreen;
  }

  _shouldMoveWindow(window) {
    return (
      this._isEnabled() &&
      this._isWindowAllowed(window) &&
      (this._shouldMoveOnMaximize(window) || this._shouldMoveOnFullscreen(window))
    );
  }

  _scheduleMove(window) {
    if (this._pendingMove.has(window))
      return;

    this._pendingMove.set(window, true);

    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._pendingMove.delete(window);

      if (!this._settings)
        return GLib.SOURCE_REMOVE;

      if (this._shouldMoveWindow(window))
        this._moveToEmptyWorkspace(window);

      return GLib.SOURCE_REMOVE;
    });
  }

  // Workspace management

  _findWorkspace(monitor, { reverse = false, start, predicate }) {
    const ws = this._getWS();
    const count = ws.get_n_workspaces();

    let s = Math.max(0, Math.min(start, count - 1));
    const range = reverse
      ? Array.from({ length: s + 1 }, (_, i) => s - i)
      : Array.from({ length: count - s }, (_, i) => s + i);

    for (const i of range) {
      const w = ws.get_workspace_by_index(i);
      const items = this._listWindowsFiltered(w, monitor);
      if (predicate(items))
        return i;
    }

    return -1;
  }

  _getFirstEmptyWorkspace(monitor) {
    return this._findWorkspace(monitor, {
      start: 0,
      predicate: items => items.length === 0,
    });
  }

  _getLastOccupiedWorkspace(monitor, currentIndex) {
    const prev = this._findWorkspace(monitor, {
      start: currentIndex - 1,
      reverse: true,
      predicate: items => items.length > 0,
    });

    if (prev !== -1) return prev;

    return this._findWorkspace(monitor, {
      start: currentIndex + 1,
      reverse: false,
      predicate: items => items.length > 0,
    });
  }

  _moveToEmptyWorkspace(window) {
    const monitor = this._getMonitor(window);

    const workspacesOnlyOnPrimary = this._mutterSettings.get_boolean('workspaces-only-on-primary');
    if (workspacesOnlyOnPrimary && monitor !== global.display.get_primary_monitor()) {
      return;
    }

    const currentWorkspace = window.get_workspace();
    const otherWindows = this._listWindowsFiltered(currentWorkspace, monitor).filter(w => w !== window);

    if (otherWindows.length === 0) {
      return;
    }

    const emptyWorkspaceIndex = this._getFirstEmptyWorkspace(monitor);
    if (emptyWorkspaceIndex === -1) {
      return;
    }

    this._movedWindows.add(window);

    const workspaceManager = this._getWS();
    const currentIndex = workspaceManager.get_active_workspace_index();

    if (currentIndex < emptyWorkspaceIndex) {
      const emptyWorkspace = workspaceManager.get_workspace_by_index(emptyWorkspaceIndex);
      workspaceManager.reorder_workspace(emptyWorkspace, currentIndex);

      otherWindows.forEach(w => {
        w.change_workspace_by_index(currentIndex, false);
      });
    }
  }

  _restoreToPreviousWorkspace(window) {
    if (!this._movedWindows.has(window)) {
      return;
    }

    const monitor = this._getMonitor(window);
    const currentWorkspace = window.get_workspace();
    const currentIndex = currentWorkspace.index();

    const workspacesOnlyOnPrimary = this._mutterSettings.get_boolean('workspaces-only-on-primary');
    if (workspacesOnlyOnPrimary && monitor !== global.display.get_primary_monitor()) {
      this._movedWindows.delete(window);
      return;
    }

    const otherWindows = this._listWindowsFiltered(currentWorkspace, monitor).filter(w => w !== window);

    if (otherWindows.length > 0) {
      this._movedWindows.delete(window);
      return;
    }

    const lastOccupiedIndex = this._getLastOccupiedWorkspace(monitor, currentIndex);
    if (lastOccupiedIndex === -1) {
      this._movedWindows.delete(window);
      return;
    }

    const workspaceManager = this._getWS();
    const wListlastoccupied = workspaceManager.get_workspace_by_index(lastOccupiedIndex)
      .list_windows().filter(w => w !== window && !w.is_always_on_all_workspaces() && w.get_monitor() === monitor);

    workspaceManager.reorder_workspace(workspaceManager.get_workspace_by_index(currentIndex), lastOccupiedIndex);
    wListlastoccupied.forEach(w => {
      w.change_workspace_by_index(lastOccupiedIndex, false);
    });

    this._movedWindows.delete(window);
  }

  // Signal handlers

  _onWindowMap(_wm, actor) {
    const window = actor.meta_window;
    this._scheduleMove(window);
  }

  _onWindowDestroy(_wm, actor) {
    const window = actor.meta_window;

    if (!this._isNormalWindow(window))
      return;

    this._pendingMove.delete(window);
    this._movedWindows.delete(window);
  }

  _onWindowSizeChange(_wm, actor, change, _oldRect) {
    const window = actor.meta_window;

    if (!this._isEnabled() || !this._isWindowAllowed(window))
      return;

    if (change === Meta.SizeChange.MAXIMIZE || change === Meta.SizeChange.FULLSCREEN) {
      this._scheduleMove(window);
    }

    if (change === Meta.SizeChange.UNMAXIMIZE) {
      this._restoreToPreviousWorkspace(window);
    }

    if (change === Meta.SizeChange.UNFULLSCREEN) {
      if (!this._settings.get_boolean('move-on-maximize') ||
          !window.is_maximized(Meta.MaximizeFlags.BOTH)) {
        this._restoreToPreviousWorkspace(window);
      }
    }
  }

  _onWindowMinimize(_wm, actor) {
    const window = actor.meta_window;

    if (!this._isNormalWindow(window)) {
      return;
    }

    this._restoreToPreviousWorkspace(window);
  }

  _onWindowUnminimize(_wm, actor) {
    const window = actor.meta_window;
    this._scheduleMove(window);
  }
}
