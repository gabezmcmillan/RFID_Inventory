# Understood: routes are thin, screens hold the work

The learner correctly inferred, unprompted, that `apps/field/app/check-in.tsx` is a
thin route that just renders `CheckInScreen` from `src/screens/checkin/`, and that
the screen component is where the displayed "things" actually live. This is real
understanding of the route-vs-component separation, not just exposure.

Refinements delivered and (seemingly) landed: (a) the route file is itself a React
component that merely delegates — "components all the way down"; (b) what makes a
file a *route* is its location in `app/` (the `expo-router` convention), not its
code; (c) the split is a deliberate "thin table-of-contents vs. real work" practice
that recurs in `apps/web` (`src/app/**/page.tsx`).

Implications: the learner is ready for Lesson 3 ("what a React component really is")
using `CheckInScreen.tsx` as the concrete example — they already grasp the file
layout, so we can now go inside a component (props, `useState`, `useEffect`, JSX)
rather than explaining where components live.
