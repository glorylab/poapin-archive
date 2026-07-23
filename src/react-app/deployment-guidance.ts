export interface DeploymentOption {
  id: "cloudflare" | "vercel" | "filebase" | "icp";
  title: string;
  badge: string;
  description: string;
  href: string;
  actionLabel: string;
  steps: string[];
  prompt: string;
}

export function personalSiteDeploymentOptions(address: string): DeploymentOption[] {
  const shortAddress = address.slice(2, 10).toLowerCase();
  const compatibilityDate = new Date().toISOString().slice(0, 10);
  return [
    {
      id: "cloudflare",
      title: "Cloudflare Drop",
      badge: "Recommended",
      description: "Drop in the ZIP and receive a live workers.dev address in moments.",
      href: "https://www.cloudflare.com/drop/",
      actionLabel: "Open Cloudflare Drop",
      steps: [
        "Upload the downloaded ZIP.",
        "Open the private Claim URL immediately.",
        "Sign in and finish claiming within 60 minutes.",
      ],
      prompt: `Unpack the POAP personal-site ZIP and confirm index.html is at the site root. It is an already-built static site: do not alter its archived data or content. Use Wrangler 4.102.0 or newer. If this environment is not signed in to Cloudflare, run:

npm exec --yes wrangler@latest -- deploy --assets <site-directory> --name poap-${shortAddress} --temporary --compatibility-date ${compatibilityDate}

If Cloudflare OAuth or API credentials are already available, remove --temporary and deploy normally. Then request the homepage and confirm HTTP 200, plus visible links to https://poap.in and https://github.com/glorylab/poapin-archive. Return the workers.dev URL. For a temporary deployment, return the Claim URL only to me and remind me to claim it within 60 minutes. Never put the Claim URL, credentials, or tokens in code, README files, logs, commits, or public messages.`,
    },
    {
      id: "vercel",
      title: "Vercel Drop",
      badge: "Vercel account",
      description: "Upload the same ZIP to create a production vercel.app project.",
      href: "https://vercel.com/drop",
      actionLabel: "Open Vercel Drop",
      steps: [
        "Sign in to Vercel and upload the ZIP.",
        "Choose a Team and project name.",
        "Deploy, then keep the production vercel.app URL.",
      ],
      prompt: `Unpack the POAP personal-site ZIP and confirm index.html is at the site root. It is an already-built static site: do not alter its archived data or content. Use the latest Vercel CLI. If this environment is not signed in, run npx vercel@latest login and give me the device authorization URL and code so I can approve it from another browser; never ask me to paste an access token into chat. After authorization, run:

npx vercel@latest --cwd <site-directory> --yes --prod

Request the deployed homepage and confirm HTTP 200, plus visible links to https://poap.in and https://github.com/glorylab/poapin-archive. Return the production vercel.app URL. Do not commit the .vercel directory or any credentials.`,
    },
    {
      id: "filebase",
      title: "Filebase Sites",
      badge: "IPFS + IPNS",
      description: "Publish the unpacked folder to IPFS with a stable myfilebase.site address.",
      href: "https://console.filebase.com/",
      actionLabel: "Open Filebase",
      steps: [
        "Unpack the ZIP; Filebase Sites accepts a folder, not the ZIP itself.",
        "Create a Site and upload the whole folder.",
        "Keep the IPNS-backed myfilebase.site URL.",
      ],
      prompt: `Unpack the POAP personal-site ZIP without changing its files. In Filebase Console, open Sites and create a new Site with an available lowercase name based on poap-${shortAddress}. Choose “Upload now” and upload the entire unpacked folder, with index.html at its root. Wait for the deployment, open the myfilebase.site URL, and confirm the homepage plus visible https://poap.in and GitHub links work. Return the public URL and deployment details. Do not upload credentials or private keys, and do not claim that remote media is permanently stored inside the site: the package intentionally references media.poap.in.`,
    },
    {
      id: "icp",
      title: "ICP Asset Canister",
      badge: "Advanced · chain-native",
      description:
        "Deploy the static folder to an updatable asset canister on the Internet Computer.",
      href: "https://docs.internetcomputer.org/guides/frontends/asset-canister/",
      actionLabel: "Read ICP guide",
      steps: [
        "Use a dedicated dfx identity with enough cycles.",
        "Configure an asset canister for the unpacked directory.",
        "Deploy and verify its icp0.io URL.",
      ],
      prompt: `Deploy this unpacked POAP personal-site directory as static assets in an Internet Computer asset canister, following the current official asset-canister guide. First show me the selected dfx identity, target network, estimated cycles, canister creation/update implications, and exact commands; wait for my approval before spending cycles or creating a canister. Keep index.html at the root, preserve all archived data unchanged, and do not embed or copy remote media. After deployment, verify the public URL, https://poap.in link, and https://github.com/glorylab/poapin-archive link. Never expose seed phrases, PEM files, identities, or wallet credentials.`,
    },
  ];
}
