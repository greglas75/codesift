/**
 * Tests for analyzeActiveRecord relation detection with Yii2 junction modifiers.
 * Mocks getCodeIndex so we can feed fabricated model sources without a real repo.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { analyzeActiveRecord } from "../../src/tools/php-tools.js";

function makeClass(name: string, file: string, source: string) {
  return {
    id: `${file}:${name}:1`,
    repo: "test",
    name,
    kind: "class" as const,
    file,
    start_line: 1,
    end_line: 100,
    start_byte: 0,
    end_byte: 0,
    source,
    tokens: [name.toLowerCase()],
  };
}

function makeGetterMethod(name: string, parent: string, file: string, source: string) {
  return {
    id: `${file}:${name}:10`,
    repo: "test",
    name,
    kind: "method" as const,
    file,
    start_line: 10,
    end_line: 15,
    start_byte: 0,
    end_byte: 0,
    source,
    tokens: [name.toLowerCase()],
    parent,
  };
}

describe("analyzeActiveRecord — relation modifier detection (Task 9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts plain hasOne relation with -> inverseOf() modifier", async () => {
    const cls = makeClass(
      "User",
      "models/User.php",
      `<?php
namespace app\\models;
class User extends ActiveRecord {
    public function getProfile() {
        return $this->hasOne(Profile::class, ['user_id' => 'id'])->inverseOf('user');
    }
}`,
    );
    const getProfile = makeGetterMethod(
      "getProfile",
      cls.id,
      "models/User.php",
      `public function getProfile() {
        return $this->hasOne(Profile::class, ['user_id' => 'id'])->inverseOf('user');
    }`,
    );

    vi.mocked(getCodeIndex).mockResolvedValue({
      repo: "test",
      root: "/tmp",
      symbols: [cls, getProfile],
      files: [{ path: "models/User.php", language: "php", symbol_count: 2, last_modified: 0 }],
      created_at: 0,
      updated_at: 0,
      symbol_count: 2,
      file_count: 1,
    });

    const r = await analyzeActiveRecord("test");
    expect(r.models).toHaveLength(1);
    const profile = r.models[0]!.relations.find((rel) => rel.name === "profile");
    expect(profile).toBeDefined();
    expect(profile!.type).toBe("hasOne"); // inverseOf is decoration, not manyMany
    expect(profile!.target_class).toBe("Profile");
  });

  it("upgrades hasMany to manyMany when ->viaTable() is chained", async () => {
    const cls = makeClass(
      "Post",
      "models/Post.php",
      `<?php
class Post extends ActiveRecord {
    public function getTags() {
        return $this->hasMany(Tag::class, ['id' => 'tag_id'])
            ->viaTable('post_tag', ['post_id' => 'id']);
    }
}`,
    );
    const getter = makeGetterMethod(
      "getTags",
      cls.id,
      "models/Post.php",
      `public function getTags() {
        return $this->hasMany(Tag::class, ['id' => 'tag_id'])
            ->viaTable('post_tag', ['post_id' => 'id']);
    }`,
    );

    vi.mocked(getCodeIndex).mockResolvedValue({
      repo: "test",
      root: "/tmp",
      symbols: [cls, getter],
      files: [{ path: "models/Post.php", language: "php", symbol_count: 2, last_modified: 0 }],
      created_at: 0,
      updated_at: 0,
      symbol_count: 2,
      file_count: 1,
    });

    const r = await analyzeActiveRecord("test");
    const tags = r.models[0]!.relations.find((rel) => rel.name === "tags");
    expect(tags).toBeDefined();
    expect(tags!.type).toBe("manyMany");
    expect(tags!.target_class).toBe("Tag");
  });

  it("upgrades hasMany to manyMany when ->via('junction') is chained", async () => {
    const cls = makeClass(
      "Course",
      "models/Course.php",
      `<?php
class Course extends ActiveRecord {
    public function getStudents() {
        return $this->hasMany(Student::class, ['id' => 'student_id'])->via('enrollments');
    }
}`,
    );
    const getter = makeGetterMethod(
      "getStudents",
      cls.id,
      "models/Course.php",
      `public function getStudents() {
        return $this->hasMany(Student::class, ['id' => 'student_id'])->via('enrollments');
    }`,
    );

    vi.mocked(getCodeIndex).mockResolvedValue({
      repo: "test",
      root: "/tmp",
      symbols: [cls, getter],
      files: [{ path: "models/Course.php", language: "php", symbol_count: 2, last_modified: 0 }],
      created_at: 0,
      updated_at: 0,
      symbol_count: 2,
      file_count: 1,
    });

    const r = await analyzeActiveRecord("test");
    const students = r.models[0]!.relations.find((rel) => rel.name === "students");
    expect(students).toBeDefined();
    expect(students!.type).toBe("manyMany");
    expect(students!.target_class).toBe("Student");
  });
});
