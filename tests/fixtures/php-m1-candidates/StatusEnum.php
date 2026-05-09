<?php
namespace app\models\enums;

class StatusEnum
{
    const ACTIVE = 'active';
    const PENDING = 'pending';
    const ARCHIVED = 'archived';
    const REJECTED = 'rejected';

    public static function getValues(): array
    {
        return [self::ACTIVE, self::PENDING, self::ARCHIVED, self::REJECTED];
    }
}
