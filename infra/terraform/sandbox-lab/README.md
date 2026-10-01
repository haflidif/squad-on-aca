# Isolated ACA Sandbox lab

These roots are **not** the legacy `infra/terraform/` root. `sandbox-lab-state`
owns only the approved RG, a storage account, a private blob container and an
optional blob data role assignment. Initialize its local backend with
`terraform -chdir=infra/terraform/sandbox-lab-state init
-backend-config="path=<absolute-private-operator-directory>/sandbox-lab-state.tfstate"`
after creating that access-restricted directory outside Git. Back up that
state securely; never initialize the bootstrap backend with the default
in-repository local state path for a deployment.
The operator needs existing Entra blob data permissions to create the private
container. If the optional principal ID is unknown, leave it null: no RBAC
assignment is made. Before applying, confirm the proposed account name is
globally available, the provided operator IPv4 egress CIDRs are correct, and
state endpoint access works under the approved network policy.
The bootstrap converts a single-host `/32` egress entry into the plain IPv4
format required by storage network rules. Confirm that the actual operator
egress IP is publicly routable before applying.

After separately approved bootstrap, copy `backend.hcl.example` to a private
file, replace the account name with the bootstrap output and initialize this
root with `terraform init -backend-config=<private-file>`. Backend uses Entra
authentication and the dedicated `sandbox-lab.tfstate` blob key. Never store
keys, SAS tokens or credentials in backend config or Terraform inputs. This
root **reads** the existing RG and the exact existing ACR; it owns only the
Sandbox Group, dispatcher UAMI, group-scoped Data Owner, environment-subject
FIC and, if explicitly supplied and separately approved, an ACR-scoped
`AcrPull` for the image-pull UAMI attached to the group. The dispatcher supplies
that UAMI's client ID as `source.managedIdentityClientId` in the v2 disk-image
request.
The two isolated roots retain their own provider lock files. Review provider
upgrades separately; do not copy the legacy root's provider selections.

Local offline validation (no plan, apply, backend or cloud authentication):

```text
terraform -chdir=infra/terraform/sandbox-lab-state init -backend=false -input=false
terraform -chdir=infra/terraform/sandbox-lab-state validate
terraform -chdir=infra/terraform/sandbox-lab init -backend=false -input=false
terraform -chdir=infra/terraform/sandbox-lab validate
```

Once outputs exist, produce an output JSON privately with `terraform output
-json` in the lab root. Both `infra/hooks/sandbox-lab-bootstrap.sh --outputs
<file> --repo AzureViking/squad-on-aca-sandbox-lab --environment
squad-sandbox-dispatch` and `infra/hooks/sandbox-lab-bootstrap.ps1 -Outputs
<file> -Repository AzureViking/squad-on-aca-sandbox-lab -Environment
squad-sandbox-dispatch` default to dry-run. Only explicit `--apply` / `-Apply`
can set the six non-secret dispatch environment variables through `ghp`,
including the Sandbox Group resource group and image-pull UAMI client ID.
The helper checks the existing protected environment first and refuses unless
exactly one `required_reviewers` rule lists at least one reviewer and has
`prevent_self_review: true`, admin bypass is off and only the `main` branch
policy exists. It does not create
the repo, environment, secrets, image, publisher or any Azure resource. For a
single-maintainer test tenant only, `--allow-self-review` / `-AllowSelfReview`
accepts a reviewer rule with `prevent_self_review: false`; the reviewer rule,
admin-bypass and main-only checks still apply and a warning is printed.
When operator egress is tunneled (for example Global Secure Access), set
`network_default_action = "Allow"` in the private state tfvars together with
any policy exemption tag the tenant requires; the default remains `Deny` and
shared keys stay disabled. Create
the private repo and protected environment manually with required reviewers,
no self-approval and main-only deployment branches, then verify those settings.
Set `SQUAD_ACA_BIN` and the immutable `SQUAD_SANDBOX_IMAGE_REF` manually after
the image/CLI contract is verified. Private ACR image pulls require the
image-pull UAMI's client ID in the v2 disk-image request and the optional
registry-scoped `AcrPull` assignment. No live plan or apply has been performed
by these instructions.
