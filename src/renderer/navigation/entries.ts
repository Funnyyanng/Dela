// 功能入口的单一真源：侧栏、折叠后标题栏图标与设置 › 通用 的显示开关都读这里。
// 功能开启 > 入口显示：隐藏只影响导航，能力仍在；功能关闭（目前只有水源）时入口消失。首页固定显示，不在此列表。
import {
  CalendarDays,
  FolderOpen,
  GraduationCap,
  Mail,
  MonitorPlay,
  House,
  ListChecks,
  BriefcaseBusiness,
  Heart,
} from 'lucide-react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ShuiyuanIcon } from '../components/ui/shuiyuan-icon';
import { useExperimentEnabled } from '../features/settings/experimental';

export type NavEntryId =
  | 'today'
  | 'jobs'
  | 'projects'
  | 'life'
  | 'sources'
  | 'learning'
  | 'mail'
  | 'timetable'
  | 'classroom'
  | 'shuiyuan';

export const navEntries: Array<{
  id: NavEntryId;
  label: string;
  icon: typeof Mail | typeof ShuiyuanIcon;
  campus?: boolean;
}> = [
  { id: 'today', label: '今天', icon: House },
  { id: 'learning', label: '学习中心', icon: GraduationCap },
  { id: 'projects', label: '项目总览', icon: BriefcaseBusiness },
  { id: 'life', label: '生活', icon: Heart },
  { id: 'jobs', label: '任务中心', icon: ListChecks },
  { id: 'sources', label: '资料', icon: FolderOpen },
  { id: 'timetable', label: '日历与课表', icon: CalendarDays },
  { id: 'mail', label: '邮箱', icon: Mail, campus: true },
  { id: 'classroom', label: '课堂视频', icon: MonitorPlay, campus: true },
  { id: 'shuiyuan', label: '水源(beta)', icon: ShuiyuanIcon, campus: true },
];

export const useNavEntryPrefs = create<{
  hidden: NavEntryId[];
  setVisible: (id: NavEntryId, visible: boolean) => void;
}>()(
  persist(
    (set) => ({
      hidden: [],
      setVisible: (id, visible) =>
        set((state) => ({
          hidden: visible
            ? state.hidden.filter((item) => item !== id)
            : [...new Set([...state.hidden, id])],
        })),
    }),
    { name: 'dela.nav-entries', partialize: (state) => ({ hidden: state.hidden }) },
  ),
);

/** 功能本身是否开启（关闭时入口不可显示、设置里的显示开关置灰）。 */
export function useNavEntryAvailable(): (id: NavEntryId) => boolean {
  const shuiyuan = useExperimentEnabled('shuiyuan');
  return (id) => id !== 'shuiyuan' || shuiyuan;
}

export function useVisibleNavEntries() {
  const hidden = useNavEntryPrefs((state) => state.hidden);
  const available = useNavEntryAvailable();
  return navEntries.filter(
    (entry) =>
      available(entry.id) &&
      (entry.id === 'today' || entry.id === 'jobs' || !hidden.includes(entry.id)),
  );
}
