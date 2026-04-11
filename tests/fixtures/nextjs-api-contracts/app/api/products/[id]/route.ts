export async function GET() {
  return NextResponse.json({ id: "abc" });
}

export async function DELETE() {
  return new Response(null, { status: 204 });
}
