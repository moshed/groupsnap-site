# GroupSnap site

Hosts the Apple App Site Association file that makes GroupSnap's universal links
(and, later, its App Clip) work.

**Do not host this on GitHub Pages.** Apple requires
`/.well-known/apple-app-site-association` to be served with
`Content-Type: application/json`. GitHub Pages serves that extensionless file as
`application/octet-stream` and offers no way to set headers, so Apple's CDN
rejects it. (Verified — not a guess.)

Deploy on **Netlify** or **Cloudflare Pages** instead; both honour the `_headers`
file here, which sets the content type correctly. Either gives a free HTTPS
subdomain (`*.netlify.app` / `*.pages.dev`) that works as an associated domain,
so no domain purchase is required.

After deploying, set the host in:
- Xcode → Signing & Capabilities → Associated Domains:
  `applinks:<host>` and `appclips:<host>`
- `GroupShare.swift` → `webHost`, and flip `useUniversalLink = true`
