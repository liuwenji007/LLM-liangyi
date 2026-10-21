/**
 * GitHub 仓库地址。页面上的投稿、勘误链接会打开对应 Issue 表单。
 */
export const repositoryUrl: string = "https://github.com/liuwenji007/LLM-liangyi";

export type IssueTemplate = "event.yml" | "meme.yml" | "correction.yml";

const guides: Record<IssueTemplate, string> = {
  "event.yml": "#event-guide",
  "meme.yml": "#meme-guide",
  "correction.yml": "#correction-guide",
};

export function issueUrl(template: IssueTemplate): string {
  if (!repositoryUrl) return guides[template];
  return `${repositoryUrl.replace(/\/$/, "")}/issues/new?template=${template}`;
}
