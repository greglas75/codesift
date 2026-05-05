<?php
use yii\db\Migration;

class m180601_120000_irreversible extends Migration
{
    public function up()
    {
        $this->createTable('events', ['id' => $this->primaryKey()]);
    }
    // No down() — irreversible. Should trigger missing-safe-down.
}
