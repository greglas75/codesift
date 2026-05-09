<?php
use yii\db\Migration;
class m230101_000000_init extends Migration {
    public function up() { $this->createTable('api_data', ['id' => $this->primaryKey()]); }
    public function down() { $this->dropTable('api_data'); }
}
