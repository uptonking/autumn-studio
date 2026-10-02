import { useCallback } from "react";
import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";

export function AutumnSidebarItem({
  currentScreen,
  openScreen,
}: PluginSidebarItemProps) {
  const open = useCallback(
    () => openScreen({ screenId: "settings" }),
    [openScreen],
  );

  return (
    <SidebarRow
      icon="Leaf"
      label="Autumn Studio"
      active={currentScreen?.screenId === "settings"}
      onPress={open}
    />
  );
}
