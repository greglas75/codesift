import { describe, it, expect, vi, beforeEach } from "vitest";
import { traceRoomSchema } from "../../src/tools/room-tools.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));
const { getCodeIndex } = await import("../../src/tools/index-tools.js");

function makeSym(overrides: Partial<CodeSymbol> & { name: string }): CodeSymbol {
  return {
    id: `test:${overrides.file ?? "db.kt"}:${overrides.name}:${overrides.start_line ?? 1}`,
    repo: "test",
    kind: overrides.kind ?? "class",
    file: overrides.file ?? "db.kt",
    start_line: overrides.start_line ?? 1,
    end_line: overrides.end_line ?? 20,
    ...overrides,
  };
}

function makeIndex(symbols: CodeSymbol[]): CodeIndex {
  return {
    repo: "test",
    root: "/tmp/test",
    symbols,
    files: [],
    created_at: 0,
    updated_at: 0,
    symbol_count: symbols.length,
    file_count: 0,
  };
}

describe("traceRoomSchema", () => {
  beforeEach(() => vi.clearAllMocks());

  it("discovers @Entity classes and links them to @Dao interfaces", async () => {
    const index = makeIndex([
      makeSym({
        name: "UserEntity",
        file: "db/UserEntity.kt",
        decorators: ["Entity"],
        source: `@Entity(tableName = "users")
data class UserEntity(
    @PrimaryKey val id: Int,
    val name: String,
    val email: String
)`,
      }),
      makeSym({
        name: "UserDao",
        kind: "interface",
        file: "db/UserDao.kt",
        decorators: ["Dao"],
        source: `@Dao
interface UserDao {
    @Query("SELECT * FROM users WHERE id = :id")
    suspend fun getById(id: Int): UserEntity?

    @Insert
    suspend fun insert(user: UserEntity)
}`,
      }),
      makeSym({
        name: "getById",
        kind: "method",
        file: "db/UserDao.kt",
        parent: "test:db/UserDao.kt:UserDao:1",
        decorators: ["Query"],
        signature: "suspend (id: Int): UserEntity?",
        source: `@Query("SELECT * FROM users WHERE id = :id")
suspend fun getById(id: Int): UserEntity?`,
      }),
      makeSym({
        name: "insert",
        kind: "method",
        file: "db/UserDao.kt",
        parent: "test:db/UserDao.kt:UserDao:1",
        decorators: ["Insert"],
        signature: "suspend (user: UserEntity): Unit",
        source: `@Insert
suspend fun insert(user: UserEntity)`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await traceRoomSchema("test");
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]!.name).toBe("UserEntity");
    expect(result.entities[0]!.table_name).toBe("users");
    expect(result.daos).toHaveLength(1);
    expect(result.daos[0]!.name).toBe("UserDao");
    expect(result.daos[0]!.queries).toHaveLength(2); // @Query + @Insert
    const queryOp = result.daos[0]!.queries.find((q) => q.annotation === "Query");
    expect(queryOp!.sql).toContain("SELECT * FROM users");
  });

  it("discovers @Database class and links entities", async () => {
    const index = makeIndex([
      makeSym({
        name: "AppDatabase",
        file: "db/AppDatabase.kt",
        decorators: ["Database"],
        source: `@Database(entities = [UserEntity::class, OrderEntity::class], version = 1)
abstract class AppDatabase : RoomDatabase()`,
      }),
      makeSym({
        name: "UserEntity",
        file: "db/UserEntity.kt",
        decorators: ["Entity"],
        source: `@Entity data class UserEntity(@PrimaryKey val id: Int)`,
      }),
      makeSym({
        name: "OrderEntity",
        file: "db/OrderEntity.kt",
        decorators: ["Entity"],
        source: `@Entity(tableName = "orders") data class OrderEntity(@PrimaryKey val id: Int)`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await traceRoomSchema("test");
    expect(result.databases).toHaveLength(1);
    expect(result.databases[0]!.name).toBe("AppDatabase");
    expect(result.databases[0]!.entity_refs).toContain("UserEntity");
    expect(result.databases[0]!.entity_refs).toContain("OrderEntity");
    expect(result.entities).toHaveLength(2);
  });

  it("returns empty schema for non-Room project", async () => {
    const index = makeIndex([
      makeSym({ name: "User", source: "class User(val name: String)" }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await traceRoomSchema("test");
    expect(result.entities).toHaveLength(0);
    expect(result.daos).toHaveLength(0);
    expect(result.databases).toHaveLength(0);
  });

  it("extracts @Query SQL strings from dao methods", async () => {
    const index = makeIndex([
      makeSym({
        name: "UserDao",
        kind: "interface",
        decorators: ["Dao"],
        source: `@Dao interface UserDao {}`,
      }),
      makeSym({
        name: "findActive",
        kind: "method",
        parent: "test:db.kt:UserDao:1",
        decorators: ["Query"],
        source: `@Query("SELECT * FROM users WHERE active = 1 ORDER BY name")
suspend fun findActive(): List<UserEntity>`,
      }),
    ]);
    vi.mocked(getCodeIndex).mockResolvedValue(index);

    const result = await traceRoomSchema("test");
    expect(result.daos[0]!.queries[0]!.sql).toContain("SELECT * FROM users WHERE active = 1");
  });
});
