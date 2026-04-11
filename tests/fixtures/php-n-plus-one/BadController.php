<?php
class BadController {
    public function actionIndex() {
        $users = User::find()->all();
        foreach ($users as $user) {
            echo $user->profile->name;
        }
    }
}
