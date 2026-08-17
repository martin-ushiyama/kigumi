export const REPO_ROOT: string;
export const OWNER_NAME: string;
export const OWNER_EMAIL: string;
export function checkProseLanguage(repoRoot?: string, relPaths?: readonly string[] | null): string[];
export function checkForbiddenWords(repoRoot?: string, relPaths?: readonly string[] | null): string[];
export function checkCommitAuthors(repoRoot: string, range: string): string[];
export function checkCommitContents(repoRoot: string, range: string): string[];
export function checkCommitMessages(repoRoot: string, range: string): string[];
export function checkText(label: string, text: string): string[];
