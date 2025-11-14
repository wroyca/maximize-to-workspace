import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class MaximizeToWorkspacePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const generalPage = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(generalPage);

        const generalGroup = new Adw.PreferencesGroup({
            title: 'Behavior',
            description: 'Configure when windows should be moved to empty workspaces',
        });
        generalPage.add(generalGroup);

        const moveOnMaximizeRow = new Adw.SwitchRow({
            title: 'Move on Maximize',
            subtitle: 'Move windows to empty workspace when maximized (not just fullscreen)',
        });
        settings.bind(
            'move-on-maximize',
            moveOnMaximizeRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        generalGroup.add(moveOnMaximizeRow);

        const restoreOnCloseRow = new Adw.SwitchRow({
            title: 'Restore on Close',
            subtitle: 'Return to previous workspace when closing a maximized window',
        });
        settings.bind(
            'restore-on-close',
            restoreOnCloseRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        generalGroup.add(restoreOnCloseRow);

        const filterPage = new Adw.PreferencesPage({
            title: 'Applications',
            icon_name: 'applications-system-symbolic',
        });
        window.add(filterPage);

        const filterModeGroup = new Adw.PreferencesGroup({
            title: 'Filter Mode',
            description: 'Control which applications are affected by this extension',
        });
        filterPage.add(filterModeGroup);

        const filterModeRow = new Adw.ComboRow({
            title: 'Application Filter',
            subtitle: 'Choose how to filter applications',
            model: new Gtk.StringList({
                strings: ['All Applications', 'Blacklist (Exclude)', 'Whitelist (Include Only)'],
            }),
        });

        const filterModeMap = {
            'none': 0,
            'blacklist': 1,
            'whitelist': 2,
        };
        const reverseFilterModeMap = ['none', 'blacklist', 'whitelist'];

        filterModeRow.set_selected(filterModeMap[settings.get_string('filter-mode')]);

        filterModeRow.connect('notify::selected', () => {
            settings.set_string('filter-mode', reverseFilterModeMap[filterModeRow.get_selected()]);
        });

        filterModeGroup.add(filterModeRow);

        const blacklistGroup = new Adw.PreferencesGroup({
            title: 'Blacklist',
            description: 'Applications in this list will NOT be moved to empty workspaces',
        });
        filterPage.add(blacklistGroup);

        const blacklistExpander = new Adw.ExpanderRow({
            title: 'Excluded Applications',
            subtitle: 'Click to view and edit',
        });
        blacklistGroup.add(blacklistExpander);

        this._createApplicationList(
            blacklistExpander,
            settings,
            'blacklist',
            'Add application WM_CLASS to blacklist'
        );

        const whitelistGroup = new Adw.PreferencesGroup({
            title: 'Whitelist',
            description: 'Only applications in this list will be moved to empty workspaces',
        });
        filterPage.add(whitelistGroup);

        const whitelistExpander = new Adw.ExpanderRow({
            title: 'Included Applications',
            subtitle: 'Click to view and edit',
        });
        whitelistGroup.add(whitelistExpander);

        this._createApplicationList(
            whitelistExpander,
            settings,
            'whitelist',
            'Add application WM_CLASS to whitelist'
        );

        const helpPage = new Adw.PreferencesPage({
            title: 'Help',
            icon_name: 'help-about-symbolic',
        });
        window.add(helpPage);

        const helpGroup = new Adw.PreferencesGroup({
            title: 'Finding Application Names',
            description: 'To find the WM_CLASS name of an application',
        });
        helpPage.add(helpGroup);

        const helpText = new Gtk.Label({
            label: '1. Open a terminal\n' +
                   '2. Run: xprop WM_CLASS\n' +
                   '3. Click on the application window\n' +
                   '4. Use the second value shown\n\n' +
                   'Example output: WM_CLASS(STRING) = "firefox", "Firefox"\n' +
                   'Use: Firefox',
            wrap: true,
            xalign: 0,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });

        const helpRow = new Adw.ActionRow();
        helpRow.set_child(helpText);
        helpGroup.add(helpRow);

        window.set_default_size(600, 700);
    }

    _createApplicationList(expanderRow, settings, settingsKey, placeholder) {
        const applications = settings.get_strv(settingsKey);

        applications.forEach(app => {
            const row = this._createApplicationRow(app, settings, settingsKey);
            expanderRow.add_row(row);
        });

        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });

        const addRow = new Adw.ActionRow({
            title: 'Add Application',
        });
        addRow.add_suffix(addButton);
        addRow.set_activatable_widget(addButton);
        expanderRow.add_row(addRow);

        addButton.connect('clicked', () => {
            this._showAddApplicationDialog(expanderRow, settings, settingsKey, placeholder);
        });
    }

    _createApplicationRow(appName, settings, settingsKey) {
        const row = new Adw.ActionRow({
            title: appName,
        });

        const removeButton = new Gtk.Button({
            icon_name: 'edit-delete-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });

        removeButton.connect('clicked', () => {
            const apps = settings.get_strv(settingsKey);
            const index = apps.indexOf(appName);
            if (index > -1) {
                apps.splice(index, 1);
                settings.set_strv(settingsKey, apps);
            }
            row.get_parent().remove(row);
        });

        row.add_suffix(removeButton);
        row.set_activatable_widget(removeButton);

        return row;
    }

    _showAddApplicationDialog(expanderRow, settings, settingsKey, placeholder) {
        const dialog = new Adw.MessageDialog({
            heading: 'Add Application',
            body: 'Enter the WM_CLASS name of the application',
            modal: true,
        });

        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('add', 'Add');
        dialog.set_response_appearance('add', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('add');
        dialog.set_close_response('cancel');

        const entry = new Gtk.Entry({
            placeholder_text: placeholder,
            activates_default: true,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
        });
        box.append(entry);
        dialog.set_extra_child(box);

        dialog.connect('response', (_dialog, response) => {
            if (response === 'add') {
                const appName = entry.get_text().trim();
                if (appName) {
                    const apps = settings.get_strv(settingsKey);
                    if (!apps.includes(appName)) {
                        apps.push(appName);
                        settings.set_strv(settingsKey, apps);

                        const addRow = expanderRow.get_row_at_index(expanderRow.get_rows().length - 1);
                        const newRow = this._createApplicationRow(appName, settings, settingsKey);
                        const index = Array.from(expanderRow.get_rows()).indexOf(addRow);
                        expanderRow.insert_child_after(newRow, expanderRow.get_row_at_index(index - 1));
                    }
                }
            }
            dialog.close();
        });

        dialog.present();
    }
}
