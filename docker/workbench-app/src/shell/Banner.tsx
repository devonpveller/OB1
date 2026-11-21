// Shown only when the server says the identity is the shipped default (no sign-in): then everyone who can
// open this page is the same person, and the page must not look private.
export function DefaultSubjectBanner() {
  return (
    <div className="banner" role="status" data-testid="default-banner">
      <strong>Sign-in is not switched on.</strong> You are using the default account, so anyone who can open this page sees the same documents.
    </div>
  );
}
