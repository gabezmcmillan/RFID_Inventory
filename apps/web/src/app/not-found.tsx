/** Friendly 404. Used by the tag page when an EPC isn't on file yet. */
export default function NotFound() {
  return (
    <>
      <main className="container">
        <h1>Not found</h1>
        <p className="muted">This box may not have synced from the warehouse yet — try again in a minute.</p>
      </main>
    </>
  );
}
