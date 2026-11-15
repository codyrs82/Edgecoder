// The GitHub CLI's sign-in, which pushing, publishing and cloning private repositories use.
// `gh auth status` starts a process, so the answer is shared until someone checks again.
import { writable } from "svelte/store";
import { gitGitHubStatus, type GitHubCliStatus } from "./api";

export const githubCli = writable<GitHubCliStatus | null>(null);

let pending: Promise<GitHubCliStatus> | null = null;

export function githubCliStatus(fresh = false): Promise<GitHubCliStatus> {
  if (!pending || fresh) {
    pending = gitGitHubStatus()
      .catch(() => ({ ghInstalled: false, loggedIn: false, login: null }))
      .then((s) => {
        githubCli.set(s);
        return s;
      });
  }
  return pending;
}
