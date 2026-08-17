export interface GitHubPlan {
  readonly operation: string;
  readonly externalWrites: false;
  readonly mode: "dry-run";
  readonly message: string;
}

/** M0 deliberately has no GitHub credentials or network client. */
export class GitHubDryRun {
  plan(operation: string): GitHubPlan {
    return {
      operation,
      externalWrites: false,
      mode: "dry-run",
      message:
        "M0 records no GitHub write. A human must perform external actions.",
    };
  }
}
