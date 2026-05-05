<?php
use yii\db\Migration;

class m180601_120000_init_rbac extends Migration
{
    public function up()
    {
        $auth = Yii::$app->authManager;

        // Roles
        $admin = $auth->createRole('admin');
        $auth->add($admin);

        $editor = $auth->createRole('editor');
        $auth->add($editor);

        // Permissions — all three should be detected as definitions
        $viewUser = $auth->createPermission('viewUser');
        $auth->add($viewUser);
        $auth->addChild($admin, $viewUser);

        $editUser = $auth->createPermission('editUser');
        $auth->add($editUser);
        $auth->addChild($admin, $editUser);

        $unusedSeed = $auth->createPermission('unusedSeed');
        $auth->add($unusedSeed);
        $auth->addChild($admin, $unusedSeed);

        // Dynamic create — should land in dynamic_creates, not definitions
        foreach (['perm.a', 'perm.b'] as $name) {
            $p = $auth->createPermission($name);
            $auth->add($p);
        }
    }

    public function down()
    {
        Yii::$app->authManager->removeAll();
    }
}
