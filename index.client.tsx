import type { PluginClientContext } from '@getpaseo/plugin/client';
import { AutumnSettingsScreen } from './client/settings-screen.js';
import { AutumnSidebarItem } from './client/sidebar-item.js';

export default function contribute(client: PluginClientContext) {
  // Main settings screen accessible from the sidebar
  client.addScreen({
    id: 'settings',
    title: 'Autumn Studio',
    Component: AutumnSettingsScreen,
  });

  // Sidebar header item placed below built-ins (History, Search, Schedules)
  client.addSidebarHeaderItem({
    id: 'autumn-studio',
    title: 'Autumn Studio',
    Component: AutumnSidebarItem,
  });

  // Also mount in Settings -> Plugins -> Autumn Studio
  client.addSettingsScreen({
    id: 'main',
    title: 'Autumn Studio',
    icon: 'Leaf',
    Component: AutumnSettingsScreen,
  });

  return () => {};
}
