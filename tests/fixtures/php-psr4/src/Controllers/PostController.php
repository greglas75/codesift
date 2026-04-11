<?php
namespace App\Controllers;

use App\Models\User;

class PostController {
    public function actionIndex() {
        $user = new User();
        return $user;
    }
}
