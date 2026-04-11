"use server";

export async function noValidationAction(input: { id: string }) {
  const session = await auth();
  if (!session) throw new Error("unauthorized");
  return input.id;
}
