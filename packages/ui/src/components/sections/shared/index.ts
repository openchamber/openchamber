/**
 * Shared boilerplate components for settings sections.
 *
 * These components provide consistent styling and behavior for settings sidebars and pages.
 * Use them as building blocks when creating new settings sections.
 *
 * @example Sidebar usage:
 * ```tsx
 * import {
 *   SettingsSidebarLayout,
 *   SettingsSidebarHeader,
 *   SettingsSidebarItem,
 * } from '@/components/sections/shared';
 *
 * export const MySidebar = () => (
 *   <SettingsSidebarLayout
 *     header={<SettingsSidebarHeader count={items.length} onAdd={handleAdd} />}
 *   >
 *     {items.map(item => (
 *       <SettingsSidebarItem
 *         key={item.id}
 *         title={item.name}
 *         metadata={item.description}
 *         selected={selectedId === item.id}
 *         onSelect={() => setSelectedId(item.id)}
 *         actions={[
 *           { label: 'Delete', onClick: () => handleDelete(item.id), destructive: true }
 *         ]}
 *       />
 *     ))}
 *   </SettingsSidebarLayout>
 * );
 * ```
 *
 * @example Page usage:
 * ```tsx
 * import { SettingsPageLayout, SettingsSection } from '@/components/sections/shared';
 *
 * export const MyPage = () => (
 *   <SettingsPageLayout>
 *     <SettingsSection title="General Settings">
 *       <MySettingsForm />
 *     </SettingsSection>
 *     <SettingsSection title="Advanced" divider>
 *       <AdvancedSettingsForm />
 *     </SettingsSection>
 *   </SettingsPageLayout>
 * );
 * ```
 */

export { SettingsSidebarLayout } from './SettingsSidebarLayout';
export { SettingsSidebarHeader } from './SettingsSidebarHeader';
export { SettingsSidebarItem, type SettingsSidebarItemAction } from './SettingsSidebarItem';
export { SettingsPageLayout } from './SettingsPageLayout';
export { SettingsSection } from './SettingsSection';
export { SidebarGroup } from './SidebarGroup';
