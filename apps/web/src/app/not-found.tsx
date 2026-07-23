/** Friendly 404. Used by the tag page when an EPC isn't on file yet. */
export default function NotFound() {
  return (
    <main className="mx-auto w-full max-w-5xl px-5 pb-16 pt-10">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Not found</h1>
      <p className="text-sm text-muted-foreground">
        This box may not have synced from the warehouse yet — try again in a minute.
      </p>
    </main>
  );
}
