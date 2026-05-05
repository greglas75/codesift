<?php
namespace app\controllers;

class FindOneInLoopController
{
    public function actionFindOneInLoop($ids)
    {
        $users = [];
        foreach ($ids as $id) {
            $users[] = User::findOne($id);                  // Pattern 4
        }
        return $users;
    }

    public function actionFindAllInLoop($groupIds)
    {
        $all = [];
        foreach ($groupIds as $gid) {
            $rows = Member::findAll(['group_id' => $gid]);   // Pattern 4
            foreach ($rows as $r) {
                $all[] = $r;
            }
        }
        return $all;
    }

    public function actionLeaveYiiAlone($cfgKeys)
    {
        // Yii::createObject is whitelisted — should not fire as Pattern 4.
        $out = [];
        foreach ($cfgKeys as $key) {
            $out[] = Yii::createObject($key);
        }
        return $out;
    }

    public function actionLeaveSelfAlone($items)
    {
        // self::find() is a recursion-prone false-positive trigger; suppressed.
        $out = [];
        foreach ($items as $i) {
            $out[] = self::find($i);
        }
        return $out;
    }
}
