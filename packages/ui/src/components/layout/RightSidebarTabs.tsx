import { RiFolder3Line, RiGitBranchLine } from "@remixicon/react";
import React from "react";
import { useTranslation } from "react-i18next";

import { SortableTabsStrip } from "@/components/ui/sortable-tabs-strip";
import { GitView } from "@/components/views";
import { useUIStore } from "@/stores/useUIStore";
import { SidebarFilesTree } from "./SidebarFilesTree";

type RightTab = "git" | "files";

export const RightSidebarTabs: React.FC = () => {
	const { t } = useTranslation();
	const rightSidebarTab = useUIStore((state) => state.rightSidebarTab);
	const setRightSidebarTab = useUIStore((state) => state.setRightSidebarTab);

	const tabItems = React.useMemo(
		() => [
			{
				id: "git",
				label: t("nav.git"),
				icon: <RiGitBranchLine className="h-3.5 w-3.5" />,
			},
			{
				id: "files",
				label: t("nav.files"),
				icon: <RiFolder3Line className="h-3.5 w-3.5" />,
			},
		],
		[t],
	);

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden bg-transparent">
			<div className="h-9 bg-transparent pt-1 px-2">
				<SortableTabsStrip
					items={tabItems}
					activeId={rightSidebarTab}
					onSelect={(tabID) => setRightSidebarTab(tabID as RightTab)}
					layoutMode="fit"
					variant="active-pill"
					className="h-full"
				/>
			</div>

			<div className="min-h-0 flex-1 overflow-hidden">
				{rightSidebarTab === "git" ? <GitView /> : <SidebarFilesTree />}
			</div>
		</div>
	);
};
