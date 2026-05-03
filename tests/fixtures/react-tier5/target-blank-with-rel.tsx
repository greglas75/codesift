// Negative: target="_blank" with proper rel — postFilter must drop
export function SafeExternalLink() {
  return (
    <a href="https://example.com" target="_blank" rel="noopener noreferrer">
      External
    </a>
  );
}
