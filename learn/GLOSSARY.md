# RFID Inventory Codebase Glossary

Canonical language for these lessons. Two kinds of terms live here:
**domain nouns** (facts of this business — safe to define now) and
**tech terms** (promoted only once the learner can use them correctly, per the
teaching rules). The repo's developers keep their own deeper domain glossary in
[`CONTEXT.md`](../CONTEXT.md); this one is tuned for a beginner.

## Domain (the business)

**RFID tag**:
A radio chip on a box that a handheld reader detects at a distance; each carries a
unique code (an EPC). One tag = one physical unit of inventory.
_Avoid_: barcode, sticker.

**EPC**:
The unique identifier burned into a tag. In the new system it is minted per-device
so two phones scanning offline can never collide.

**Check in**:
Recording a box <em>into</em> the warehouse by scanning its tag on arrival.

**Check out**:
Recording a box <em>leaving</em> the warehouse (shipped to a jobsite).

**BOL (Bill of Lading)**:
The shipping document that arrives with a truckload; scanned/photographed and
attached to the boxes it covers.

**Material request**:
A jobsite user's ask for stock ("send 4 of these"), submitted on the website and
fulfilled by the warehouse.

## Technology

_Terms are promoted here only after the learner has shown they can use them
correctly. Lesson 1 introduced client, server, database, framework, package,
monorepo, TypeScript, React, Expo, Next.js, Turso, and ORM — none are promoted yet
(coverage is not mastery). They will move here as the learner demonstrates them._
