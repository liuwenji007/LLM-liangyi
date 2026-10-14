/**
 * 换成真实 GitHub 仓库地址后，页面上的投稿链接会打开 Issue 表单。
 * 例：https://github.com/your-name/liangyi
 */
export const repositoryUrl: string = "";

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
