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

    this._movedWindows = new WeakMap();
    this._pendingMove = new Set();
    this._pendingMoveSourceId = 0;
    this._signals = [];
    this._mutterSettings = null;
    this._quickSettingsItem = null;
    this._blacklist = new Set();
    this._whitelist = new Set();
    this._filterMode = 'none';
    this._enabled = false;
    this._moveOnMaximize = false;
    this._restoreOnClose = false;
    this._createWorkspaceAtEnd = true;
    this._workspacesOnlyOnPrimary = false;
    this._settings = null;
    this._settingsCacheId = null;
    this._mutterSettingsId = null;
  }

  enable() {
    this._settings = this.getSettings();
    this._mutterSettings = new Gio.Settings({
      schema_id: 'org.gnome.mutter'
    });

    this._enabled = this._settings.get_boolean('enabled');
    this._moveOnMaximize = this._settings.get_boolean('move-on-maximize');
    this._restoreOnClose = this._settings.get_boolean('restore-on-close');
    this._createWorkspaceAtEnd = this._settings.get_boolean('create-workspace-at-end');
    this._workspacesOnlyOnPrimary = this._mutterSettings.get_boolean('workspaces-only-on-primary');

    this._registerSimpleSettingsCache();

    this._settingsCacheId.push(
      this._settings.connect('changed::enabled', () => {
        this._enabled = this._settings.get_boolean('enabled');
        if (!this._enabled) {
          this._pendingMove.clear();
          this._movedWindows = new WeakMap();
        }
      }),
      this._settings.connect('changed::move-on-maximize', () => {
        this._moveOnMaximize = this._settings.get_boolean('move-on-maximize');
      }),
      this._settings.connect('changed::restore-on-close', () => {
        this._restoreOnClose = this._settings.get_boolean('restore-on-close');
      }),
      this._settings.connect('changed::create-workspace-at-end', () => {
        this._createWorkspaceAtEnd = this._settings.get_boolean('create-workspace-at-end');
      })
    );

    this._mutterSettingsId = this._mutterSettings.connect(
      'changed::workspaces-only-on-primary',
      () => {
        this._workspacesOnlyOnPrimary =
          this._mutterSettings.get_boolean('workspaces-only-on-primary');
      }
    );

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

    if (this._pendingMoveSourceId) {
      GLib.source_remove(this._pendingMoveSourceId);
      this._pendingMoveSourceId = 0;
    }

    this._pendingMove.clear();
    this._movedWindows = new WeakMap();

    if (this._settingsCacheId && this._settings) {
      for (const id of this._settingsCacheId)
        this._settings.disconnect(id);
      this._settingsCacheId = null;
    }

    if (this._mutterSettingsId && this._mutterSettings) {
      this._mutterSettings.disconnect(this._mutterSettingsId);
      this._mutterSettingsId = null;
    }

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
    const all = workspace.list_windows();
    const out = [];

    for (const w of all) {
      if (!w.is_always_on_all_workspaces() && w.get_monitor() === monitor)
        out.push(w);
    }

    return out;
  }

  _registerSimpleSettingsCache() {
    const rebuild = () => {
      this._blacklist = new Set(this._settings.get_strv('blacklist'));
      this._whitelist = new Set(this._settings.get_strv('whitelist'));
      this._filterMode = this._settings.get_string('filter-mode');
    };

    rebuild();

    this._settingsCacheId = this._settingsCacheId || [];
    this._settingsCacheId.push(
      this._settings.connect('changed::blacklist', rebuild),
      this._settings.connect('changed::whitelist', rebuild),
      this._settings.connect('changed::filter-mode', rebuild),
    );
  }

  _isEnabled() {
    return this._enabled;
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
    return this._moveOnMaximize &&
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
    if (!this._enabled || !this._isWindowAllowed(window))
      return;

    if (this._pendingMove.has(window))
      return;

    this._pendingMove.add(window);

    if (this._pendingMoveSourceId !== 0)
      return;

    this._pendingMoveSourceId = GLib.idle_add(
      GLib.PRIORITY_DEFAULT_IDLE,
      () => {
        this._pendingMoveSourceId = 0;

        if (!this._settings || !this._enabled) {
          this._pendingMove.clear();
          return GLib.SOURCE_REMOVE;
        }

        const windows = Array.from(this._pendingMove);
        this._pendingMove.clear();

        for (const w of windows) {
          if (this._shouldMoveWindow(w))
            this._moveToEmptyWorkspace(w);
        }

        return GLib.SOURCE_REMOVE;
      }
    );
  }

  // Workspace management

  _findWorkspace(monitor, { reverse = false, start, predicate }) {
    const ws = this._getWS();
    const count = ws.get_n_workspaces();

    let s = Math.max(0, Math.min(start, count - 1));

    if (reverse) {
      for (let i = s; i >= 0; --i) {
        const w = ws.get_workspace_by_index(i);
        const items = this._listWindowsFiltered(w, monitor);
        if (predicate(items))
          return i;
      }
    } else {
      for (let i = s; i < count; ++i) {
        const w = ws.get_workspace_by_index(i);
        const items = this._listWindowsFiltered(w, monitor);
        if (predicate(items))
          return i;
      }
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

    if (this._workspacesOnlyOnPrimary &&
        monitor !== global.display.get_primary_monitor()) {
      return;
    }

    const currentWorkspace = window.get_workspace();
    const otherWindows = this._listWindowsFiltered(currentWorkspace, monitor)
      .filter(w => w !== window);

    if (otherWindows.length === 0)
      return;

    const emptyWorkspaceIndex = this._getFirstEmptyWorkspace(monitor);
    if (emptyWorkspaceIndex === -1) {
      return;
    }

    const workspaceManager = this._getWS();
    const currentIndex = workspaceManager.get_active_workspace_index();

    this._movedWindows.set(window, currentIndex);

    if (this._createWorkspaceAtEnd) {
      // The swap relies on two explicit reorder operations. GNOME Shell exposes
      // workspace movement as a positional update rather than a true "insert"
      // semantic, so a direct move would shift the visible stack and trigger an
      // animated workspace transition. The sequence below avoids that.
      //
      // First step moves the empty workspace into the current position. This
      // places it logically where we want to land, but it also shifts the
      // workspace that used to occupy that slot to the next index.
      //
      // Second step moves that displaced workspace back to the original
      // location of the empty workspace.
      //
      // After the layout is stable, window reassignment proceeds using the
      // final indices.
      //
      const emptyWorkspace = workspaceManager.get_workspace_by_index(emptyWorkspaceIndex);
      workspaceManager.reorder_workspace(emptyWorkspace, currentIndex);
      workspaceManager.reorder_workspace(
        workspaceManager.get_workspace_by_index(currentIndex + 1),
        emptyWorkspaceIndex
      );

      for (const w of otherWindows)
        w.change_workspace_by_index(currentIndex, false);
    } else {
      if (currentIndex < emptyWorkspaceIndex) {
        const emptyWorkspace = workspaceManager.get_workspace_by_index(emptyWorkspaceIndex);
        workspaceManager.reorder_workspace(emptyWorkspace, currentIndex);

        for (const w of otherWindows)
          w.change_workspace_by_index(currentIndex, false);
      }
    }
  }

  _restoreToPreviousWorkspace(window) {
    if (!this._movedWindows.has(window)) {
      return;
    }

    const monitor = this._getMonitor(window);
    const currentWorkspace = window.get_workspace();
    const currentIndex = currentWorkspace.index();

    if (this._workspacesOnlyOnPrimary && monitor !== global.display.get_primary_monitor()) {
      this._movedWindows.delete(window);
      return;
    }

    const otherWindows = this._listWindowsFiltered(currentWorkspace, monitor)
      .filter(w => w !== window);

    if (otherWindows.length > 0) {
      this._movedWindows.delete(window);
      return;
    }

    const originalIndex = this._movedWindows.get(window);
    if (originalIndex === undefined) {
      this._movedWindows.delete(window);
      return;
    }

    const workspaceManager = this._getWS();

    const originalWorkspace = workspaceManager.get_workspace_by_index(originalIndex);
    if (!originalWorkspace) {
      this._movedWindows.delete(window);
      return;
    }

    const wListOriginal = originalWorkspace.list_windows()
      .filter(w => w !== window && !w.is_always_on_all_workspaces() && w.get_monitor() === monitor);

    workspaceManager.reorder_workspace(workspaceManager.get_workspace_by_index(currentIndex), originalIndex);
    for (const w of wListOriginal)
      w.change_workspace_by_index(originalIndex, false);

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

    if (this._restoreOnClose) {
      this._restoreToPreviousWorkspace(window);
    } else {
      this._movedWindows.delete(window);
    }
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
      if (!this._moveOnMaximize ||
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
