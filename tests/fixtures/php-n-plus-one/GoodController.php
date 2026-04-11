<?php
class GoodController {
    public function actionIndex() {
        $users = User::find()->with('profile')->all();
        foreach ($users as $user) {
            echo $user->profile->name;
        }
    }
}
