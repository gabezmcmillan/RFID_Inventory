# RFID Inventory Codebase — Resources

Trusted sources for learning the technologies in this repo. Prefer official docs;
they stay current and match the versions we actually use. Every lesson's claims
should trace back to something here or to a file in the repo itself.

## Knowledge

### The languages
- [The TypeScript Handbook (official)](https://www.typescriptlang.org/docs/handbook/intro.html)
  Canonical intro to the language the whole re-write is in. Use for: what "types"
  are and why they catch mistakes Python wouldn't.
- [MDN Web Docs — JavaScript](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
  The web's reference manual (Mozilla). TypeScript is JavaScript + types, so this
  is the base. Use for: any core language question (arrays, functions, `async`).

### The web fundamentals (for a true beginner)
- [MDN — "How the web works"](https://developer.mozilla.org/en-US/docs/Learn_web_development/Getting_started/Web_standards/How_the_web_works)
  Plain-English client/server/request explainer. Use for: grounding the
  client vs server vs database vocabulary from lesson 1.

### The frameworks
- [Next.js docs (official)](https://nextjs.org/docs) — the `apps/web` website framework.
  Use for: how pages, the App Router, and Server Components work.
- [Expo docs (official)](https://docs.expo.dev/) — the `apps/field` iPhone-app toolkit.
  Use for: how a React Native app is structured, `expo-router` file-based screens.
- [React — "Learn React" (official)](https://react.dev/learn)
  The idea shared by BOTH apps (web via Next.js, phone via React Native). Use for:
  components, props, state. The single most leveraged thing to learn here.

### The data layer
- [Drizzle ORM docs (official)](https://orm.drizzle.team/docs/overview)
  How `packages/domain` defines the database shape and queries it in TypeScript.
- [Turso docs (official)](https://docs.turso.tech/)
  The one database, and its local-first sync that replaced the old `sync.py`.

### Auth
- [Better Auth docs (official)](https://www.better-auth.com/docs/introduction)
  The sign-in library in `apps/web`. Use for: sessions, the Microsoft (Entra) SSO,
  the QR device-linking plugins.

### In-repo primary sources (highest trust — written for THIS project)
- `plans/README.md` — the authoritative description of the re-write and its status.
- `README.md` — full description of the OLD Python system (great for old-vs-new).
- `CONTEXT.md` — the domain glossary the original developers keep.
- `apps/web/README.md` — how the new website's auth + databases are wired.

## Wisdom (Communities)
- [Stack Overflow](https://stackoverflow.com/) — for concrete "why won't this
  compile / run" questions once you start editing code.
- [r/reactnative](https://www.reddit.com/r/reactnative/) and
  [Reactiflux Discord](https://www.reactiflux.com/) — active, reasonably moderated
  communities for React / React Native / Next.js questions.

> Community preference not yet stated. Ask the learner before pushing them to post
> publicly — some prefer to learn privately first.

## Gaps
- No single beginner resource ties *all* of these together for a non-web-dev; that
  is exactly the gap these custom lessons fill.
