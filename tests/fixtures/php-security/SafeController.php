<?php
class SafeController {
    public function actionShow($id) {
        $id = (int) $id;
        $user = User::findOne($id);
        return $this->render('show', ['user' => $user]);
    }
}
