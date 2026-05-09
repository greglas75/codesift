<?php

use yii\db\Migration;

class m180601_120000_perms extends Migration
{
    public function up()
    {
        $auth = Yii::$app->authManager;
        $admin = $auth->createRole('admin');
        $auth->add($admin);

        $permission = $auth->createPermission('viewUser');
        $auth->add($permission);
        $auth->addChild($admin, $permission);
    }

    public function down()
    {
        $auth = Yii::$app->authManager;
        $auth->remove($auth->getRole('admin'));
    }
}
