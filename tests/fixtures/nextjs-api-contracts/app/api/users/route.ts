import { z } from "zod";

const CreateUserSchema = z.object({
  name: z.string(),
  email: z.string(),
});

export async function GET() {
  return NextResponse.json({ users: [] });
}

export async function POST(req: Request) {
  const body = CreateUserSchema.parse(await req.json());
  return NextResponse.json(body, { status: 201 });
}
