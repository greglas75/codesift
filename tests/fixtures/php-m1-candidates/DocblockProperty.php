<?php
namespace app\models;

class DocblockProperty
{
    /** @var string */
    public $name;

    /** @var int */
    private $count;

    /** @var bool */
    protected $enabled;

    /** @var User|null */
    public $owner;

    /** @var \app\models\Profile|null */
    public $profile;
}
