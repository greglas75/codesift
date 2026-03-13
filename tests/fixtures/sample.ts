/**
 * Fetches a user by their unique identifier.
 */
export async function getUserById(id: string): Promise<User | null> {
  return db.user.findUnique({ where: { id } });
}

export const createUser = async (data: CreateUserInput): Promise<User> => {
  return db.user.create({ data });
};

interface User {
  id: string;
  name: string;
  email: string;
}

interface CreateUserInput {
  name: string;
  email: string;
}

type UserRole = "admin" | "user" | "guest";

export class UserService {
  private readonly cache = new Map<string, User>();

  async findById(id: string): Promise<User | null> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    return getUserById(id);
  }

  async updateRole(id: string, role: UserRole): Promise<void> {
    await db.user.update({ where: { id }, data: { role } });
  }
}

enum Status {
  Active = "active",
  Inactive = "inactive",
}

const MAX_RETRIES = 3;

describe("UserService", () => {
  it("should find user by id", async () => {
    const user = await service.findById("123");
    expect(user).toBeDefined();
  });

  test("handles missing user", async () => {
    const user = await service.findById("nonexistent");
    expect(user).toBeNull();
  });
});
