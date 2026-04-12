<?php
class BadCode {
    public function dangerousEval() {
        eval('echo 1;');
    }
    public function dangerousSystem() {
        system('ls');
    }
    public function dangerousExec() {
        exec('date');
    }
}
