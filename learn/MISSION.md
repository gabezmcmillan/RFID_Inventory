# Mission: Maintain & change the RFID Inventory codebase (and learn web dev doing it)

> **Status: CONFIRMED** by the learner on first session (2026-07-23).

## Why
The learner is responsible for this RFID inventory system, freshly re-written from
a local Python desktop app + Python cloud site into an iOS app + a new web app on a
shared TypeScript codebase. Over the **next ~two weeks** they need to be able to
maintain and make changes to it themselves. They're using this real, high-stakes
project as their on-ramp to learning web development practices generally — so every
lesson should both explain *this repo* and teach the *transferable idea* behind it.

## Success looks like
- Can open the repo and explain what each top-level folder is for. *(lesson 1 target)*
- Can trace one box end-to-end: checked in on the phone → the database → visible
  and requestable on the website.
- Can name the big pieces (Expo/React Native, Next.js, the shared domain package,
  Turso, Drizzle, Better Auth) and say what each does in a sentence.
- Can read an "important" file (a screen, a repository function, the schema) and
  explain what it does and why — not write it from scratch, but follow it.
- Can make a small, safe change and know which files it touches and how to check it.

## Constraints
- **Two-week horizon** — bias toward the parts most likely to need maintenance
  first; don't rabbit-hole on theory that can wait.
- Beginner: little to no prior web-dev knowledge. Define jargon on first use.
- Learn from THIS real codebase, not toy examples. Every lesson anchors to actual
  files/folders and, where it helps, names the transferable web-dev practice.

## Depth
Concepts and the map first, but go one level deeper on the *important* parts:
enough to read and reason about the key code, and make small changes — not (yet)
to build large features unaided.

## Out of scope (for now)
- Building large production features unaided.
- Deep dives into RFID hardware / TSL protocol internals.
- Deployment/DevOps mechanics (Vercel, EAS, Tailscale) beyond a one-line mention.
