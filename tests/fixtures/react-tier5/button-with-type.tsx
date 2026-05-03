// Negative: <button type="button"> — explicit type, must NOT match
export function TypedButton() {
  const handleClick = () => console.log("clicked");
  return <button type="button" onClick={handleClick}>Save</button>;
}
