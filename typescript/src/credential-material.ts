/** Recognizable credential stores must not enter generic material or artifact flows. */
export function credentialMaterialPath(path: string): boolean {
  const parts = path.replaceAll("\\", "/").toLowerCase().split("/").filter(Boolean);
  return parts.some((part, index) => {
    if (
      [
        ".netrc", "_netrc", ".git", ".gitconfig", ".git-credentials", ".ssh",
        ".aws", ".gnupg", ".npmrc", ".pypirc", "auth.json",
        "credential.json", "credentials.json", "credentials", ".credentials",
      ].includes(part) ||
      part === ".env" || part.startsWith(".env.") ||
      part.startsWith(".git-credential-")
    ) return true;
    const previous = parts[index - 1], beforePrevious = parts[index - 2];
    return (
      (part === "config" && [".docker", ".kube"].includes(previous)) ||
      (part === "config.json" && previous === ".docker") ||
      (part === "hosts.yml" && previous === "gh" && beforePrevious === ".config") ||
      (["config", "credentials"].includes(part) && previous === "git" && beforePrevious === ".config")
    );
  });
}
