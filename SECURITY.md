# Security Policy

## Trust model

Pi packages and extensions run with the full local permissions of the user account that starts Pi. Review extension source before installing it, pin versions in sensitive environments, and install only from trusted sources.

```bash
pi install npm:@senad-d/branchme@<version>
pi install git:https://github.com/senad-d/branchme@<tag>
```

## Current implementation status

BranchMe is currently prepared but not implemented. The planned git and GitHub behaviors below are documented for the later implementation session and must be validated before publishing.

## Planned security-sensitive behavior

BranchMe is planned to:

- Run local `git` commands through Pi's extension API using argv-style arguments.
- Create and checkout a new branch from current `HEAD` when `create_branch` is called.
- Push or publish the current branch to `origin` when `push_branch` is called.
- Create GitHub pull requests through the GitHub REST API when `pull_request` is called.
- Read `GITHUB_TOKEN` or `GH_TOKEN` from the process environment for GitHub authentication.

BranchMe is planned not to:

- Stage files.
- Create commits.
- Generate commit messages.
- Edit working-tree files.
- Read `.env` token files in v1.
- Depend on GitHub CLI.
- Send telemetry.
- Accept owner/repo tool parameters for pull request creation.

## Current-repository boundary

BranchMe tools must operate only on the repository where Pi is running. The PR tool must infer the GitHub repository from the current checkout and/or matching `GITHUB_REPOSITORY`. If environment and local repository metadata disagree, the implementation should fail closed.

## Credentials

Do not paste tokens into prompts, issues, logs, or test fixtures. The later implementation must redact token values from errors and tool details.

## Reporting vulnerabilities

Please report suspected security vulnerabilities privately by email: <senad.dizdarevic@proton.me>.

For non-sensitive issues, use the repository issue tracker:

<https://github.com/senad-d/branchme/issues>

Do not open public issues for security-sensitive reports that include exploit details, private repository contents, secrets, or credentials.

## Secure development checklist

- Do not commit secrets, tokens, local `.pi/` state, or generated artifacts.
- Document any file, shell, network, or credential access added by the extension.
- Avoid starting background resources in the extension factory.
- Keep package contents minimal with `npm run check:pack`.
- Use isolated smoke tests with `pi --no-extensions -e .`.
