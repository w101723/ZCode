import { join } from "node:path";
import type { SkillRoot } from "@zcode/contracts";

/**
 * 动态工作流灰度门在 App 装配层的两处减法。
 * 工具面的减法在 core 的 registerBuiltInTools，`/` 目录的减法在 zcode-protocol/slash-commands.ts；
 * 这里只放「命令展开」和「技能发现」这两项需要 bootstrap 侧常量/路径推导的。
 */

/** 灰度关闭时不允许展开的自定义命令名；`workflow` 命令与动态工作流相关。 */
export const DYNAMIC_WORKFLOW_GATED_COMMAND_NAMES: readonly string[] = ["workflow"];

/** 系统内置技能里工作流编写指南技能的目录名（skills/<dir>/SKILL.md）。 */
const DYNAMIC_WORKFLOW_SKILL_DIRECTORY_NAME = "dynamic-workflows";

const SKILL_MANIFEST_FILE_NAME = "SKILL.md";

/**
 * 灰度关闭时要从技能发现中剔除的 SKILL.md 绝对路径。
 */
export function collectDynamicWorkflowDisabledSkillPaths(
  skillRoots: readonly SkillRoot[],
): string[] {
  return skillRoots.map((root) =>
    join(root.path, DYNAMIC_WORKFLOW_SKILL_DIRECTORY_NAME, SKILL_MANIFEST_FILE_NAME),
  );
}
