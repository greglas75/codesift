<?php
class MethodCallController {
    public function actionBad() {
        $users = User::find()->all();
        foreach ($users as $user) {
            echo $user->getProfile()->name;
        }
    }

    public function actionGood() {
        $users = User::find()->with('profile')->all();
        foreach ($users as $user) {
            echo $user->getProfile()->name;
        }
    }

    public function actionBlocklisted() {
        $users = User::find()->all();
        foreach ($users as $user) {
            $user->save();
            $user->validate();
        }
    }
}
