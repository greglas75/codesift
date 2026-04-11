<?php
class ScalarAccess {
    public function actionIndex() {
        $users = User::find()->all();
        foreach ($users as $user) {
            echo $user->id;
            echo $user->name;
        }
    }
}
