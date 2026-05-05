<?php
namespace app\models;

class PromotableUser
{
    public $name;
    public $email;
    public $age;

    public function __construct($name, $email, $age)
    {
        $this->name = $name;
        $this->email = $email;
        $this->age = $age;
    }
}
