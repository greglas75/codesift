<?php
namespace app\models;

class ReadonlyCandidate
{
    public string $name;
    public int $createdAt;
    public string $mutated;

    public function __construct(string $name, int $createdAt)
    {
        $this->name = $name;
        $this->createdAt = $createdAt;
        $this->mutated = 'initial';
    }

    // mutated has a setter — should NOT be flagged readonly
    public function setMutated(string $value): void
    {
        $this->mutated = $value;
    }
}
