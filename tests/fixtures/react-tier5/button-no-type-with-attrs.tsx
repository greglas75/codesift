// Positive: <button onClick={x}> without type — defaults to submit
export function WithAttrsButton() {
  const handleClick = () => console.log("clicked");
  return <button onClick={handleClick}>Save</button>;
}
